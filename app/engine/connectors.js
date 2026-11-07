// Outside-world actions. Apps connect through Composio (the default) or, for Gmail,
// directly with the client's own Google app. While test mode is on, nothing that
// changes the outside world runs: it's logged instead. Reads always run.

function createConnectors({ store, gmail, composio }) {
  let bigJobs = null; // set by attachBigJobs: big jobs are built after the runtime, since they call it

  async function logInstead(task, bot, what, why) {
    if (task) await store.addStep(task.id, `${what}: recorded, not done (${why})`, 'bot');
    await store.postFeed({ botId: bot.id, taskId: task ? task.id : null, kind: 'action_logged', importance: 'info', summary: `${what} logged (${why})` });
    return { done: false, sent: false, logged: true, reason: why };
  }

  async function execute(action, payload, { bot, task }) {
    const testMode = await store.getSetting('test_mode', true);

    if (action === 'send_email') {
      const direct = !!(await store.getSetting('connector_gmail', null));
      const viaApps = !direct && (await composio.activeToolkits().catch(() => [])).includes('gmail');
      if (testMode || (!direct && !viaApps)) {
        return logInstead(task, bot, `Email "${payload.subject}" to ${payload.to}`, testMode ? 'test mode is on' : 'Gmail is not connected yet');
      }
      let sent;
      if (direct) {
        sent = await gmail.send(payload);
      } else {
        await composio.run('GMAIL_SEND_EMAIL', { recipient_email: payload.to, subject: payload.subject, body: payload.body, ...(payload.cc ? { cc: [payload.cc] } : {}) }, { botId: bot.id, taskId: task.id });
        sent = { id: null, from: 'connected Gmail' };
      }
      await store.addStep(task.id, `Email sent to ${payload.to} from ${sent.from}`, 'bot');
      await store.postFeed({ botId: bot.id, taskId: task.id, kind: 'email_sent', importance: 'important', summary: `Sent "${payload.subject}" to ${payload.to}` });
      await store.audit('bot', bot.id, 'email.send', { taskId: task.id, to: payload.to, subject: payload.subject, via: direct ? 'gmail' : 'composio' });
      return { sent: true, gmail_id: sent.id || undefined, thread_id: sent.threadId || undefined };
    }

    if (action === 'app_action') {
      const risk = composio.riskOf(payload.slug);
      if (testMode && risk !== 'read') return logInstead(task, bot, payload.slug, 'test mode is on');
      const data = await composio.run(payload.slug, payload.arguments, { botId: bot.id, taskId: task ? task.id : null });
      if (risk !== 'read') {
        if (task) await store.addStep(task.id, `Ran ${payload.slug}`, 'bot');
        await store.audit('bot', bot.id, 'app.action', { taskId: task ? task.id : null, slug: payload.slug });
        if (['send', 'pay', 'delete'].includes(risk)) {
          await store.postFeed({ botId: bot.id, taskId: task ? task.id : null, kind: 'app_action', importance: 'important', summary: `${payload.summary || payload.slug} done` });
        }
      }
      return risk === 'read' ? data : { done: true, data };
    }
    // Runs in test mode too: a big job only makes files, it can't reach the outside world.
    if (action === 'big_job') {
      const job = await bigJobs.start({ bot, task, title: payload.title, instructions: payload.instructions, fileIds: payload.file_ids, web: payload.web });
      return { done: true, job_id: job.id };
    }
    throw new Error(`No connector for ${action}`);
  }

  function attachBigJobs(b) { bigJobs = b; }

  return { execute, attachBigJobs };
}

module.exports = { createConnectors };
