// Tools the bots can call. Each has a JSON schema for Claude, a risk tag for the
// policy engine, and a run() that returns { result, cards }. Cards show up in chat.
const fs = require('fs');
const path = require('path');
const { needsApproval } = require('./policy');
const { cleanTrigger } = require('./triggers');

// Tools that only appear once their connector is set up.
const NEEDS = { search_email: 'gmail', read_email: 'gmail', app_find_actions: 'apps', app_run_action: 'apps', find_app_events: 'apps' };

const SCHEDULE = {
  type: 'object',
  description: 'When it runs, in the business\'s timezone',
  properties: {
    freq: { type: 'string', enum: ['hourly', 'daily', 'weekdays', 'weekly'] },
    time: { type: 'string', description: '24-hour "HH:MM", for daily, weekdays and weekly' },
    day: { type: 'integer', description: 'Weekly only: 1 = Monday … 7 = Sunday' },
    minute: { type: 'string', description: 'Hourly only: minutes past the hour, "00"–"59"' },
  },
  required: ['freq'],
};

const DEFS = [
  {
    name: 'create_task',
    tag: 'internal',
    description: 'Create a task for a piece of work the user asked you to DO (an action with an outcome). Call this first, before working on any action request. Do not call it for questions or requests for information.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Follow up with 3 quiet leads"' },
        description: { type: 'string', description: 'One plain sentence saying what this task is about and why, for the task board' },
        instructions: { type: 'string', description: 'What done looks like, in one or two sentences' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_up_recurring',
    tag: 'internal',
    description: 'Make work repeat on its own as a recurring task. Use it when the person wants something done regularly ("every Monday", "each morning", "weekly") or whenever something happens in a connected app ("when a new lead emails", "each time a deal closes"). If a request is clearly routine, offer to make it recurring. Give either a schedule or an app_event. Each run hands you the instructions and you create a task as usual. Check list_recurring first so you don\'t set up the same thing twice.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "Monday pipeline report" (up to 60 characters)' },
        instructions: { type: 'string', description: 'What to do on each run, written so it makes sense on its own weeks from now' },
        schedule: SCHEDULE,
        app_event: {
          type: 'object',
          description: 'Run when something happens in a connected app. Call find_app_events first and use its exact event slug.',
          properties: { app: { type: 'string', description: 'App slug, e.g. "gmail"' }, event: { type: 'string' }, config: { type: 'object' } },
          required: ['app', 'event'],
        },
        bot_id: { type: 'string', description: 'The bot that should do it; leave out for yourself' },
      },
      required: ['name', 'instructions'],
    },
  },
  {
    name: 'find_app_events',
    tag: 'read',
    description: 'List the events a connected app can start recurring work on (e.g. a new Gmail message), with any settings each needs.',
    input_schema: { type: 'object', properties: { app: { type: 'string', description: 'App slug, e.g. "gmail" or "hubspot"' } }, required: ['app'] },
  },
  {
    name: 'list_recurring',
    tag: 'read',
    description: 'List the business\'s recurring tasks: what runs, when, which bot, and whether it\'s on.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'change_recurring',
    tag: 'internal',
    description: 'Change a recurring task when the person asks: rename it, change its instructions or schedule, or pause (on: false) and resume it.',
    input_schema: {
      type: 'object',
      properties: {
        recurring_id: { type: 'string' },
        name: { type: 'string' },
        instructions: { type: 'string' },
        schedule: SCHEDULE,
        on: { type: 'boolean' },
      },
      required: ['recurring_id'],
    },
  },
  {
    name: 'remove_recurring',
    tag: 'internal',
    description: 'Stop and delete a recurring task when the person asks. Tasks it already created stay.',
    input_schema: { type: 'object', properties: { recurring_id: { type: 'string' } }, required: ['recurring_id'] },
  },
  {
    name: 'start_big_job',
    tag: 'internal',
    description: 'Hand heavy work to a cloud sandbox that can run code and work with files: analysing a big export, building a report, spreadsheet, Word or PowerPoint file. Use it when the work is too big for chat, after create_task. It runs in the background and has a spend limit; you get a [Big job finished] message with its summary and files. The sandbox has no logins and can\'t send anything, so anything that must go out still goes through your own tools. Write the instructions so they stand alone: the sandbox can\'t see this chat and can\'t ask questions.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string', description: 'Short name, e.g. "Q3 revenue analysis"' },
        instructions: { type: 'string', description: 'Everything the job needs to know, and what files to produce' },
        file_ids: { type: 'array', items: { type: 'string' }, description: 'Files to hand to the job' },
        web: { type: 'boolean', description: 'True only if the job must search or read the web. The Owner has to allow this.' },
      },
      required: ['task_id', 'title', 'instructions'],
    },
  },
  {
    name: 'update_task',
    tag: 'internal',
    description: 'Log progress on a task. When you believe the work is finished, set status "review" with a short result: a person checks it and marks it done. You can never mark a task done yourself. Use "failed" with the reason if you can\'t finish.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'review', 'failed'] },
        note: { type: 'string', description: 'One line for the task log' },
        result: { type: 'string', description: 'What you did, for the person reviewing it' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ask_for_feedback',
    tag: 'internal',
    description: 'Ask the user a question you need answered before you can continue a task. The task waits until they reply.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, question: { type: 'string' } },
      required: ['task_id', 'question'],
    },
  },
  {
    name: 'send_email',
    tag: 'send',
    description: 'Send an email from the business\'s Gmail. Depending on policy this waits for human approval first; if so, do not send it again: you will be told the outcome.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text email body, written in the business\'s voice' },
        thread_id: { type: 'string', description: 'When replying: thread_id from read_email' },
        in_reply_to: { type: 'string', description: 'When replying: message_id from read_email' },
      },
      required: ['task_id', 'to', 'subject', 'body'],
    },
  },
  {
    name: 'search_email',
    tag: 'read',
    description: 'Search the connected Gmail inbox. Uses Gmail search syntax, e.g. "from:acme.com newer_than:7d" or "is:unread in:inbox". Returns sender, subject, date and a snippet for each match.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max: { type: 'string', description: 'How many results, 1-25 (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'app_find_actions',
    tag: 'read',
    description: 'Find the actions you can take in a connected app (Gmail, HubSpot, QuickBooks, Calendar…). Describe what you want to do; you get back action slugs, what each does, its risk and its input schema. Call this before app_run_action.',
    input_schema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App slug from the connected list, e.g. "hubspot". Leave out to search all connected apps.' },
        query: { type: 'string', description: 'What you want to do, e.g. "find deals not updated in 7 days"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'app_run_action',
    tag: 'app', // real tag comes from the action (read / write / send / pay / delete)
    description: 'Run one action in a connected app, using a slug and arguments that match the input schema from app_find_actions. Reads run straight away; sends, changes, payments and deletes may need human approval first. If so, stop and tell the person; you will be told the outcome.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Action slug, e.g. HUBSPOT_SEARCH_DEALS' },
        arguments: { type: 'object', description: 'Arguments matching the action\'s input schema' },
        task_id: { type: 'string', description: 'The task this is for (required for anything other than reads)' },
        summary: { type: 'string', description: 'One plain-English line for the approval card, e.g. "Move Acme deal to Proposal sent"' },
      },
      required: ['slug', 'arguments'],
    },
  },
  {
    name: 'read_email',
    tag: 'read',
    description: 'Read one email in full (headers and plain-text body) by the id from search_email.',
    input_schema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'create_artifact',
    tag: 'internal',
    description: 'Save a document you produced (report, proposal, email sequence, brief, table) so the team can view, export and reuse it. Use for substantial outputs, not short chat answers.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string', enum: ['report', 'proposal', 'email_sequence', 'brief', 'table', 'document'] },
        content: { type: 'string', description: 'The full document in Markdown' },
        task_id: { type: 'string' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'save_file',
    tag: 'internal',
    description: 'Save a generated text file (CSV, Markdown, TXT) to the Files library.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name with extension, e.g. overdue-invoices.csv' },
        content: { type: 'string' },
        task_id: { type: 'string' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'read_file',
    tag: 'read',
    description: 'Read a file someone attached in chat or to a task template, by its file id (shown as "name (fil_…)"). Text files come back as text; PDFs and images come back as the document itself.',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
  },
  {
    name: 'post_update',
    tag: 'internal',
    description: 'Post an important event to the team\'s Information Feed (things a manager would want to know). Routine steps belong in update_task instead.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        importance: { type: 'string', enum: ['info', 'important', 'critical'] },
        task_id: { type: 'string' },
      },
      required: ['summary'],
    },
  },
];

// The tool list is part of the cached prompt prefix, so it only changes when a connector does.
// Every bot always gets the full tool list, connected or not: changing the list
// mid-conversation would invalidate the bot's earlier thinking. runTool refuses
// tools whose system isn't connected instead.
function toolDefinitions() {
  return DEFS.map(({ tag, ...def }) => def);
}

const NOT_CONNECTED = {
  gmail: 'Gmail is not connected. Tell the person an Owner can connect it in Settings.',
  apps: 'No apps are connected yet. Tell the person an Owner can connect them in Settings.',
};

function tagFor(name) {
  return (DEFS.find((d) => d.name === name) || {}).tag;
}

// Minimal schema check: required fields present, strings are strings, enums respected.
function validate(name, input) {
  const def = DEFS.find((d) => d.name === name);
  if (!def) return `Unknown tool ${name}`;
  if (!input || typeof input !== 'object') return 'Input must be an object';
  for (const key of def.input_schema.required || []) {
    if (input[key] === undefined || input[key] === '') return `Missing ${key}`;
  }
  for (const [key, spec] of Object.entries(def.input_schema.properties)) {
    if (input[key] === undefined) continue;
    if (spec.type === 'string' && typeof input[key] !== 'string') return `${key} must be a string`;
    if (spec.type === 'object' && (typeof input[key] !== 'object' || Array.isArray(input[key]) || input[key] === null)) return `${key} must be an object`;
    if (spec.enum && !spec.enum.includes(input[key])) return `${key} must be one of ${spec.enum.join(', ')}`;
  }
  return null;
}

async function runTool(name, input, ctx) {
  const { store, bot, user } = ctx;
  // Only people mark tasks done; a bot's "done" becomes a suggestion for review.
  if (name === 'update_task' && input && input.status === 'done') input = { ...input, status: 'review' };
  const problem = validate(name, input);
  if (problem) return { error: problem };
  const need = NEEDS[name];
  if (need && ctx.connected && !ctx.connected[need]) return { error: NOT_CONNECTED[need] };

  const taskFor = async (id) => {
    const task = id ? await store.getTask(id) : null;
    if (!task) throw toolError(`No task ${id}. Create one with create_task first.`);
    if (task.bot_id !== bot.id) throw toolError(`Task ${id} belongs to another bot.`);
    return task;
  };

  switch (name) {
    case 'create_task': {
      const task = await store.createTask({
        title: input.title, description: input.description, instructions: input.instructions, priority: input.priority, bot_id: bot.id,
        status: 'in_progress', source: ctx.source || 'chat',
        // A task started by a schedule or app event was created by the bot, not a person.
        created_by_type: ['schedule', 'trigger'].includes(ctx.source) ? 'bot' : 'user', created_by: user ? user.id : null,
      });
      ctx.taskId = task.id;
      if (!input.description && ctx.describeTask) ctx.describeTask(task.id);
      return { result: { task_id: task.id, status: 'in_progress' }, cards: [{ type: 'task', task_id: task.id }] };
    }
    case 'update_task': {
      const task = await taskFor(input.task_id);
      const status = input.status;
      if (['approval_needed', 'awaiting_feedback'].includes(task.status) && status === 'review') {
        throw toolError(`Task ${task.id} is waiting on a person (${task.status}); it can't go to review yet.`);
      }
      if (['done', 'cancelled'].includes(task.status) && status) throw toolError(`Task ${task.id} is already ${task.status}.`);
      if (input.note) await store.addStep(task.id, input.note, 'bot');
      const fields = {};
      if (status) fields.status = status;
      if (input.result) fields.result = input.result;
      const updated = Object.keys(fields).length ? await store.updateTask(task.id, fields) : task;
      if (status === 'review') {
        await store.postFeed({ botId: bot.id, taskId: task.id, kind: 'task_review', importance: 'important', summary: `Ready for your review: ${task.title}${input.result ? ` (${input.result})` : ''}` });
        return { result: { task_id: updated.id, status: updated.status, note: 'A person will review it and mark it done, or reopen it with notes.' }, cards: [{ type: 'task', task_id: task.id }] };
      }
      if (input.status === 'failed') {
        await store.postFeed({ botId: bot.id, taskId: task.id, kind: 'task_failed', importance: 'important', summary: `Couldn't finish: ${task.title}${input.result ? ` (${input.result})` : ''}` });
      }
      return { result: { task_id: updated.id, status: updated.status }, cards: [] };
    }
    case 'ask_for_feedback': {
      const task = await taskFor(input.task_id);
      await store.askFeedback(task.id, input.question);
      return { result: { task_id: task.id, status: 'awaiting_feedback', note: 'Wait for the user to answer; do not continue this task until then.' }, cards: [{ type: 'feedback', task_id: task.id }] };
    }
    case 'send_email': {
      const task = await taskFor(input.task_id);
      const payload = { to: input.to, subject: input.subject, body: input.body };
      if (input.thread_id) payload.threadId = input.thread_id;
      if (input.in_reply_to) payload.inReplyTo = input.in_reply_to;
      if (needsApproval('send', bot.autonomy)) {
        await store.requestApproval(task.id, { action: 'send_email', summary: `Send "${input.subject}" to ${input.to}`, payload });
        return { result: { task_id: task.id, status: 'approval_needed', note: 'Queued for human approval. Do not send it again; you will be told the outcome.' }, cards: [{ type: 'approval', task_id: task.id }] };
      }
      const sent = await ctx.connectors.execute('send_email', payload, { bot, task });
      return { result: { task_id: task.id, ...sent }, cards: [] };
    }
    case 'search_email': {
      const results = await ctx.gmail.search(input.query, Number(input.max) || 10);
      return { result: { count: results.length, messages: results }, cards: [] };
    }
    case 'read_email': {
      return { result: await ctx.gmail.read(input.message_id), cards: [] };
    }
    case 'app_find_actions': {
      const actions = await ctx.composio.searchActions({ toolkit: input.app, query: input.query });
      return { result: { actions }, cards: [] };
    }
    case 'app_run_action': {
      const risk = ctx.composio.riskOf(input.slug);
      if (risk === 'read') {
        const data = await ctx.connectors.execute('app_action', { slug: input.slug, arguments: input.arguments }, { bot, task: input.task_id ? await taskFor(input.task_id) : null });
        return { result: truncate(data), cards: [] };
      }
      const task = await taskFor(input.task_id || ctx.taskId);
      await ctx.composio.describe(input.slug); // fail early on a made-up slug
      const app = input.slug.split('_')[0];
      const payload = { slug: input.slug, app: app.toLowerCase(), arguments: input.arguments, risk };
      if (needsApproval(risk, bot.autonomy)) {
        const summary = input.summary || `${humanize(input.slug)} in ${app[0]}${app.slice(1).toLowerCase()}`;
        await store.requestApproval(task.id, { action: 'app_action', summary, payload });
        return { result: { task_id: task.id, status: 'approval_needed', note: 'Queued for human approval. Do not run it again; you will be told the outcome.' }, cards: [{ type: 'approval', task_id: task.id }] };
      }
      const data = await ctx.connectors.execute('app_action', payload, { bot, task });
      return { result: truncate(data), cards: [] };
    }
    case 'create_artifact': {
      if (input.task_id) await taskFor(input.task_id);
      const art = await store.createArtifact({ title: input.title, kind: input.kind, content: input.content, botId: bot.id, taskId: input.task_id || ctx.taskId });
      return { result: { artifact_id: art.id }, cards: [{ type: 'artifact', artifact_id: art.id }] };
    }
    case 'save_file': {
      if (input.task_id) await taskFor(input.task_id);
      const mime = /\.csv$/i.test(input.name) ? 'text/csv' : /\.md$/i.test(input.name) ? 'text/markdown' : 'text/plain';
      const file = await store.saveFile({ name: input.name, mime, buffer: Buffer.from(input.content, 'utf8'), source: 'bot', botId: bot.id, taskId: input.task_id || ctx.taskId });
      return { result: { file_id: file.id, name: file.name }, cards: [{ type: 'file', file_id: file.id }] };
    }
    case 'read_file': {
      const file = await store.getFile(input.file_id);
      if (!file || file.deleted_at) throw toolError(`No file ${input.file_id}.`);
      if (file.size > 10 * 1024 * 1024) throw toolError(`${file.name} is over 10 MB; ask the person for the part you need.`);
      const buf = fs.readFileSync(file.storage_path);
      const ext = path.extname(file.name).toLowerCase();
      // PDFs and images go back as the document itself so Claude can read them.
      if (ext === '.pdf') {
        return { content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: file.name }], cards: [] };
      }
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) {
        return { content: [{ type: 'image', source: { type: 'base64', media_type: file.mime, data: buf.toString('base64') } }], cards: [] };
      }
      if (/^text\//.test(file.mime) || ['.txt', '.md', '.csv', '.json', '.html', '.xml', '.tsv', '.log'].includes(ext)) {
        const text = buf.toString('utf8');
        return { result: { name: file.name, text: text.slice(0, 60000), truncated: text.length > 60000 }, cards: [] };
      }
      throw toolError(`${file.name} can't be read directly (only text, PDF and images). Ask the person to export it as PDF or CSV.`);
    }
    case 'post_update': {
      const item = await store.postFeed({ botId: bot.id, taskId: input.task_id || ctx.taskId, kind: 'update', importance: input.importance || 'info', summary: input.summary });
      return { result: { feed_id: item.id }, cards: [] };
    }
    case 'start_big_job': {
      const task = await taskFor(input.task_id);
      const payload = { title: input.title.slice(0, 120), instructions: input.instructions, file_ids: Array.isArray(input.file_ids) ? input.file_ids : [], web: input.web === true || input.web === 'true' };
      if (needsApproval('write', bot.autonomy)) {
        await store.requestApproval(task.id, { action: 'big_job', summary: `Run a big job: ${payload.title}`, payload });
        return { result: { task_id: task.id, status: 'approval_needed', note: 'Queued for human approval. Do not start it again; you will be told the outcome.' }, cards: [{ type: 'approval', task_id: task.id }] };
      }
      const { job_id: jobId } = await ctx.connectors.execute('big_job', payload, { bot, task });
      return { result: { job_id: jobId, task_id: task.id, status: 'running', note: 'Running in the background. Tell the person, then stop; a [Big job finished] message will bring you the result.' }, cards: [{ type: 'task', task_id: task.id }] };
    }
    case 'set_up_recurring': {
      if (!input.schedule === !input.app_event) throw toolError('Give either a schedule or an app_event, not both.');
      const botId = input.bot_id || bot.id;
      if (!(await store.getBot(botId))) throw toolError(`No bot ${botId}.`);
      const ev = input.app_event;
      if (ev) {
        if (ctx.connected && !ctx.connected.apps) return { error: NOT_CONNECTED.apps };
        const types = await ctx.composio.listTriggerTypes(String(ev.app || '').toLowerCase());
        const type = types.find((x) => x.slug === ev.event);
        if (!type) throw toolError(`${ev.app} has no event ${ev.event}. Call find_app_events and use an exact slug.`);
        ev.name = type.name;
      }
      const fields = cleanTrigger({
        name: input.name, bot_id: botId, instructions: input.instructions, kind: ev ? 'app' : 'schedule',
        ...(input.schedule ? { schedule: input.schedule } : {}),
        ...(ev ? { app_event: { app: String(ev.app).toLowerCase(), slug: ev.event, name: ev.name, config: ev.config } } : {}),
      }, true);
      const t = await ctx.triggers.create(fields, null);
      await store.postFeed({ botId: bot.id, kind: 'recurring', importance: 'info', summary: `New recurring task: ${t.name} (${t.when})` });
      return { result: { recurring_id: t.id, when: t.when, next_run: t.next_run, note: 'Tell the person what will happen and when; they can pause or remove it under Tasks > Recurring.' }, cards: [] };
    }
    case 'find_app_events': {
      const types = await ctx.composio.listTriggerTypes(String(input.app).toLowerCase());
      return { result: { events: types.map((x) => ({ event: x.slug, name: x.name, description: String(x.description || '').slice(0, 300), config: x.config })) }, cards: [] };
    }
    case 'list_recurring': {
      const rows = await ctx.triggers.list();
      return { result: { recurring: rows.map((t) => ({ id: t.id, name: t.name, bot_id: t.bot_id, when: t.when, on: t.enabled, next_run: t.next_run, instructions: t.instructions })) }, cards: [] };
    }
    case 'change_recurring': {
      const fields = cleanTrigger({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.on !== undefined ? { enabled: input.on === true || input.on === 'true' } : {}),
      }, false);
      const t = await ctx.triggers.update(input.recurring_id, fields, null);
      return { result: { recurring_id: t.id, when: t.when, on: t.enabled, next_run: t.next_run }, cards: [] };
    }
    case 'remove_recurring': {
      const t = await ctx.triggers.get(input.recurring_id);
      if (!t) throw toolError(`No recurring task ${input.recurring_id}.`);
      await ctx.triggers.remove(t.id, null);
      await store.postFeed({ botId: bot.id, kind: 'recurring', importance: 'info', summary: `Stopped recurring task: ${t.name}` });
      return { result: { removed: t.id }, cards: [] };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// App responses can be huge (whole inboxes); keep what goes back to the model bounded.
function truncate(data, max = 30000) {
  const s = JSON.stringify(data ?? null);
  return s.length <= max ? data : { truncated: true, preview: s.slice(0, max) };
}

function humanize(slug) {
  const words = String(slug).split('_').slice(1).join(' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toolError(message) {
  const err = new Error(message);
  err.toolError = true;
  return err;
}

module.exports = { toolDefinitions, runTool, tagFor, validate };
