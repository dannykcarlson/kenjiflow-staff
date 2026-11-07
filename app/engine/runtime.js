// Bot runtime: one agent loop per bot turn. Turns for the same bot run one at a
// time so the conversation history stays append-only.
const { toolDefinitions, runTool } = require('./tools');
const { describeError } = require('./llm');

const MAX_STEPS = 10;

function createRuntime({ store, llm, connectors, gmail, composio, memory }) {
  const queues = new Map();
  let triggers = null; // set by attachTriggers: triggers are built after the runtime, since they call it

  function enqueue(botId, job) {
    const prev = queues.get(botId) || Promise.resolve();
    const next = prev.then(job, job).catch((err) => console.error(`[bot ${botId}]`, err));
    queues.set(botId, next);
    return next;
  }

  // Stays the same between turns: rebuilding it invalidates the bot's earlier
  // thinking. Things that change (connections, the date) go in contextNote().
  async function systemPrompt(bot) {
    const biz = await store.getSetting('business', {});
    return [
      `You are ${bot.name}, an AI staff member at ${biz.name || 'the business'}. Your role: ${bot.role_title || bot.name}.`,
      biz.about ? `About the business: ${biz.about}` : '',
      biz.voice ? `Write in the business's voice: ${biz.voice}` : '',
      bot.instructions ? `Your instructions:\n${bot.instructions}` : '',
      `How you work:
- If the person asks a question or wants information, answer it directly in chat. Do not create a task.
- If they ask you to DO something (an action with an outcome), call create_task first, then do the work, logging progress with update_task and finishing with status "review" so a person can check it.
- If the work should repeat ("every Monday", "each morning", "whenever a new lead emails"), set it up with set_up_recurring instead of doing it once. If a one-off request is clearly routine, do it and offer to make it recurring.
- Anything that leaves the business (emails, record changes) goes through your tools; some need human approval. When a tool says an action is waiting for approval, stop and tell the person, and don't repeat the action.
- If you need information only a person can give, call ask_for_feedback and stop.
- For work too heavy for chat (crunching a big export or spreadsheet, building a report or an Excel, Word or PowerPoint file), use start_big_job. It runs in the background: tell the person it started and stop. A [Big job finished] message brings you the result to check.
- Save substantial documents with create_artifact. Keep chat replies short and plain.
- Never invent data you don't have. If a system isn't connected yet, say so.
- Messages may end with a [Context] note from the app: the latest connected systems and today's date. The most recent one is current.
- Messages may also carry a [Memory] note: what you and the other bots have learned about this person in earlier conversations. Use it quietly where it helps; it can be out of date, so trust what the person says now over it.`,
    ].filter(Boolean).join('\n\n');
  }

  function contextNote(gmailConn, apps) {
    const day = new Date().toISOString().slice(0, 10);
    return `[Context] ${connectedLine(gmailConn, apps)} Today is ${day}.`;
  }

  async function refreshStatus(botId) {
    const tasks = (await store.listTasks({ role: 'owner' }, { botId }));
    const open = tasks.filter((t) => !['done', 'failed', 'cancelled'].includes(t.status));
    let status = 'Idle';
    if (open.some((t) => t.status === 'approval_needed')) status = 'Needs your approval';
    else if (open.some((t) => t.status === 'awaiting_feedback')) status = 'Waiting on your answer';
    else if (open.some((t) => t.status === 'review')) status = 'Work ready for your review';
    else if (open.some((t) => t.status === 'in_progress')) status = `Working: ${open.find((t) => t.status === 'in_progress').title}`;
    await store.updateBot(botId, { status_text: status.slice(0, 80) });
  }

  // userText is what the person typed; engineText is a follow-up the engine sends
  // the bot after someone acts on a card, and eventText is its one-line chat label.
  // source marks where work came from (chat, schedule, trigger) on any task the turn creates.
  function send(botId, { userText, engineText, eventText, user, taskId = null, source = 'chat' }) {
    return enqueue(botId, () => turn(botId, { userText, engineText, eventText, user, taskId, source }));
  }

  async function turn(botId, { userText, engineText, eventText, user, taskId, source }) {
    const bot = await store.getBot(botId);
    if (!bot) return;
    const paused = await store.getSetting('paused', false);
    const prompt = userText || engineText;
    const gmailConn = await store.getSetting('connector_gmail', null);
    const apps = composio ? await composio.activeToolkits().catch(() => []) : [];
    // A new [Context] note is appended only when it changed, so history stays append-only.
    const note = contextNote(gmailConn, apps);
    const noteChanged = note !== await store.getSetting(`context_${botId}`, null);
    const apiContent = [{ type: 'text', text: prompt }];
    if (noteChanged) apiContent.push({ type: 'text', text: note });
    // Long-term memory about the person (Honcho), only for messages a person typed.
    const remembered = memory && userText && user ? await memory.recall({ user, query: userText }) : '';
    if (remembered) apiContent.push({ type: 'text', text: `[Memory] About ${user.name}:\n${remembered}` });
    await store.addMessage({
      botId, role: 'user', apiContent,
      text: userText || '', hidden: !userText, userId: user ? user.id : null,
    });
    if (noteChanged) await store.setSetting(`context_${botId}`, note, { silent: true });
    if (engineText) {
      // Event lines are visible even though the turn itself is engine-authored.
      await store.addMessage({ botId, role: 'user', text: '', cards: [{ type: 'event', text: eventText || engineText.replace(/^\[[^\]]+\]\s*/, '') }] });
    }
    if (paused) {
      await store.addMessage({ botId, role: 'assistant', text: 'All bots are paused by the kill switch. I\'ll pick this up when an Owner or Manager resumes us.' });
      return;
    }
    const spent = await store.monthSpend(botId);
    if (spent >= bot.monthly_cap_usd) {
      await store.addMessage({ botId, role: 'assistant', text: `I've hit my AI budget for this month ($${bot.monthly_cap_usd}). An Owner can raise it in my settings.` });
      await store.postFeed({ botId, kind: 'spend_cap', importance: 'critical', summary: `${bot.name} paused: monthly AI budget reached` });
      return;
    }

    await store.updateBot(botId, { status_text: 'Thinking…' });
    const connected = { gmail: !!gmailConn, apps: apps.length > 0 };
    const ctx = { store, bot, user, taskId, connectors, gmail, composio, triggers, connected, source, describeTask };
    const system = await systemPrompt(bot);
    const tools = toolDefinitions();
    const replies = [];

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const messages = await store.apiHistory(botId);
        const response = await llm.create({ system, tools, messages });
        const cost = llm.costOf(response.usage);
        await store.recordUsage({ botId, taskId: ctx.taskId, model: response.model || llm.model, usage: response.usage || {}, costUsd: cost });

        if (response.stop_reason === 'refusal') {
          await store.addMessage({ botId, role: 'assistant', apiContent: response.content, text: "I can't help with that one." });
          break;
        }

        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        const results = [];
        const cards = [];
        for (const use of toolUses) {
          try {
            const out = await runTool(use.name, use.input, ctx);
            if (out.error) {
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: out.error });
            } else {
              // out.content: blocks (a PDF or image from read_file); otherwise JSON text.
              results.push({ type: 'tool_result', tool_use_id: use.id, content: out.content || JSON.stringify(out.result) });
              cards.push(...(out.cards || []));
            }
          } catch (err) {
            if (!err.toolError) console.error(`[tool ${use.name}]`, err);
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: err.message });
          }
        }

        const replyText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
        if (replyText) replies.push(replyText);
        await store.addMessage({
          botId, role: 'assistant', apiContent: response.content.length ? response.content : null,
          text: replyText, cards, hidden: !replyText && cards.length === 0,
        });

        // Every tool_use needs its tool_result in history, even if we stop here.
        // They go back as one user turn (keeps parallel tool calls working).
        if (toolUses.length) await store.addMessage({ botId, role: 'user', apiContent: results, hidden: true });
        if (!toolUses.length || response.stop_reason !== 'tool_use') break;
      }
      // Let Honcho learn from the exchange in the background.
      if (memory && userText && user) memory.record({ bot, user, userText, botText: replies.join('\n\n') });
    } catch (err) {
      console.error(`[bot ${bot.name}]`, err);
      await store.addMessage({ botId, role: 'assistant', text: describeError(err, llm) });
    } finally {
      await refreshStatus(botId);
    }
  }

  // Fills in a one-sentence description for a task that doesn't have one (manual tasks,
  // templates, or a bot that skipped it). Runs in the background; never blocks the task.
  async function describeTask(taskId) {
    try {
      const task = await store.getTask(taskId);
      if (!task || task.description) return;
      let text = '';
      if (llm.provider === 'mock') {
        text = (task.instructions || '').split(/(?<=[.!?])\s/)[0] || `${task.title}.`;
      } else {
        const response = await llm.create({
          system: 'You write the one-sentence description shown under a task title on a small business\'s task board. Plain words, at most 20 words, no preamble, no quotes. Say what the task is about and why, not how.',
          messages: [{ role: 'user', content: [{ type: 'text', text: `Title: ${task.title}\nInstructions: ${task.instructions || '(none)'}` }] }],
        });
        await store.recordUsage({ botId: task.bot_id, taskId, model: response.model || llm.model, usage: response.usage || {}, costUsd: llm.costOf(response.usage) });
        text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      }
      if (text) await store.updateTask(taskId, { description: text.slice(0, 300) }, 'system');
    } catch (err) {
      console.warn(`[describe ${taskId}]`, err.message);
    }
  }

  function attachTriggers(t) { triggers = t; }

  return { send, refreshStatus, describeTask, attachTriggers };
}

function connectedLine(gmailConn, apps) {
  const parts = [];
  if (gmailConn) parts.push(`Gmail (${gmailConn.email}) via search_email / read_email / send_email`);
  if (apps.length) parts.push(`these apps via app_find_actions then app_run_action: ${apps.join(', ')}${apps.includes('gmail') && !gmailConn ? ' (send email with send_email)' : ''}`);
  return parts.length
    ? `Connected systems: ${parts.join('; ')}. Anything not listed is not connected; say so rather than guessing.`
    : 'Connected systems: none yet, so you cannot look up email, CRM or accounting data. Say so if asked.';
}

module.exports = { createRuntime };
