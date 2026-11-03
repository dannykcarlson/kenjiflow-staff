// Every tool carries a risk tag. Internal tools only touch this app (tasks, feed,
// artifacts); the rest act on the outside world and follow the bot's autonomy level.
const TAGS = ['internal', 'read', 'write', 'send', 'pay', 'delete'];

const ALWAYS_ASK = new Set(['pay', 'delete']);

function needsApproval(tag, autonomy) {
  if (!TAGS.includes(tag)) return true; // unknown = be safe
  if (tag === 'internal' || tag === 'read') return false;
  if (ALWAYS_ASK.has(tag)) return true;
  if (autonomy === 'just_do_it') return false;
  if (autonomy === 'ask_risky') return tag === 'send';
  return true; // ask_all
}

const DEFAULT_RULES = [
  { action: 'send_email', roles: ['owner', 'manager'], label: 'Outgoing emails need an Owner or Manager' },
  { action: '*', roles: ['owner'], label: 'Everything else needs the Owner' },
];

function ruleFor(action, rules = DEFAULT_RULES) {
  return rules.find((r) => r.action === action) || rules.find((r) => r.action === '*') || DEFAULT_RULES[1];
}

function canApprove(user, approval) {
  if (!user || !approval) return false;
  if (user.role === 'owner') return true;
  return (approval.roles || []).includes(user.role);
}

module.exports = { TAGS, needsApproval, ruleFor, canApprove, DEFAULT_RULES };
