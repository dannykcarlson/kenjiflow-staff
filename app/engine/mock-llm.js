// A scripted stand-in for Claude so the app runs end to end with no API key.
// It answers questions in chat and turns action requests into tasks, approvals
// and artifacts, using the same message/tool shapes as the real API.

let n = 0;
const tid = () => `mock_tool_${++n}`;

function lastPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const text = m.content.find((c) => c.type === 'text');
    if (text) return { index: i, text: text.text };
  }
  return { index: -1, text: '' };
}

function toolResultsSince(messages, index) {
  const results = [];
  for (const m of messages.slice(index + 1)) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type !== 'tool_result') continue;
      try { results.push(JSON.parse(typeof c.content === 'string' ? c.content : c.content[0].text)); } catch { results.push({}); }
    }
  }
  return results;
}

const isQuestion = (t) => /\?\s*$/.test(t) || /^(what|how|who|when|why|which|where|is|are|do|does|did|can you tell|tell me|show me|list)\b/i.test(t.trim());

function titleFrom(text) {
  const clean = text.replace(/^(please|can you|could you|hey|hi)[, ]+/i, '').replace(/[.!]+$/, '').trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1, 70);
}

const reply = (content, stop = 'end_turn') => ({
  id: `mock_${Date.now()}`, model: 'mock', role: 'assistant', type: 'message',
  content, stop_reason: stop, usage: { input_tokens: 0, output_tokens: 0 },
});
const text = (t) => ({ type: 'text', text: t });
const call = (name, input) => ({ type: 'tool_use', id: tid(), name, input });

async function mockCreate({ messages }) {
  const { index, text: prompt } = lastPrompt(messages);
  const results = toolResultsSince(messages, index);
  const stage = results.length;
  const taskId = (results.find((r) => r.task_id) || {}).task_id || (prompt.match(/T-\d{4}/) || [])[0];

  // Follow-ups the engine sends after a person acts on a card.
  if (prompt.startsWith('[Approval]')) {
    const approved = /approved/i.test(prompt);
    if (stage === 0 && approved) return reply([call('update_task', { task_id: taskId, status: 'review', result: 'Email approved and handled' })], 'tool_use');
    return reply([text(approved ? `Done. ${taskId} is ready for your review.` : `Understood. I won't send it. Tell me what to change and I'll redraft ${taskId}.`)]);
  }
  if (prompt.startsWith('[Feedback]')) {
    if (stage === 0) return reply([call('update_task', { task_id: taskId, status: 'review', note: 'Got the answer, finishing up', result: 'Completed with your input' })], 'tool_use');
    return reply([text(`Thanks, that's what I needed. ${taskId} is ready for your review.`)]);
  }
  if (prompt.startsWith('[Trigger]')) {
    const name = (prompt.match(/^\[Trigger\] "([^"]+)"/) || [])[1] || 'Trigger';
    if (stage === 0) return reply([call('create_task', { title: name, instructions: 'Started by a trigger' })], 'tool_use');
    if (stage === 1) return reply([call('update_task', { task_id: taskId, status: 'review', result: 'Handled (demo mode)' })], 'tool_use');
    return reply([text(`Handled "${name}". ${taskId} is ready for your review.`)]);
  }
  if (prompt.startsWith('[Task assigned]')) {
    if (stage === 0) return reply([call('update_task', { task_id: taskId, status: 'in_progress', note: 'Picked up the task' })], 'tool_use');
    return reply([text(`On it. I've started ${taskId} and will post here when it needs you.`)]);
  }

  if (isQuestion(prompt)) {
    return reply([text("Here's the short answer from what I can see. (I'm running in **demo mode**: connect a Claude API key and I'll answer from your Gmail, HubSpot and QuickBooks data.) No task was created, since you asked a question.")]);
  }

  const wantsEmail = /\b(email|e-mail|follow ?up|reply|send|chase|remind)\b/i.test(prompt);
  const wantsDoc = /\b(report|draft|proposal|summary|summari[sz]e|brief|plan|sequence)\b/i.test(prompt);
  const wantsInput = /\b(quote|price|pricing)\b/i.test(prompt);

  if (stage === 0) return reply([text("On it. I'll track this as a task."), call('create_task', { title: titleFrom(prompt), instructions: prompt })], 'tool_use');

  if (stage === 1) {
    if (wantsInput) return reply([call('ask_for_feedback', { task_id: taskId, question: 'What price should I quote, and is the usual 50% deposit OK?' })], 'tool_use');
    if (wantsEmail) {
      return reply([call('send_email', {
        task_id: taskId, to: 'jordan@acme.example', subject: 'Quick follow-up',
        body: "Hi Jordan,\n\nJust checking in on the proposal we sent last week. Happy to walk through it on a 15-minute call if that's easier.\n\nBest,\nMaya",
      })], 'tool_use');
    }
    if (wantsDoc) {
      return reply([call('create_artifact', {
        task_id: taskId, title: titleFrom(prompt), kind: 'report',
        content: `# ${titleFrom(prompt)}\n\n_Demo draft. With Claude connected this is written from your real data._\n\n## Summary\n- Pipeline is healthy: 12 open deals worth $86,400\n- 3 deals have gone quiet for 7+ days\n- 2 invoices are overdue ($6,250 total)\n\n## Next steps\n1. Follow up the quiet deals this week\n2. Chase the overdue invoices on Friday\n3. Review proposal pricing for Q1\n`,
      })], 'tool_use');
    }
    return reply([call('update_task', { task_id: taskId, status: 'review', result: 'Done (demo mode)' })], 'tool_use');
  }

  if (stage === 2 && wantsDoc && !wantsEmail && !wantsInput) {
    return reply([call('update_task', { task_id: taskId, status: 'review', result: 'Draft saved to Artifacts' })], 'tool_use');
  }

  const last = results[results.length - 1] || {};
  if (last.status === 'approval_needed') return reply([text(`I've drafted it. It's waiting for your approval on ${taskId}. Nothing goes out until you approve it.`)]);
  if (last.status === 'awaiting_feedback') return reply([text(`I need one answer from you before I can finish ${taskId}.`)]);
  return reply([text(`All done. ${taskId} is ready for your review: mark it done when you're happy.`)]);
}

module.exports = { mockCreate };
