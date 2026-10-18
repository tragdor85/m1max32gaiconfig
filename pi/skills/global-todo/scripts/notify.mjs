/**
 * Shared iMessage notification format for the global-todo loop.
 * One format for all outcomes — start / done / failed:
 *   "<emoji> Todo <id> "<title>" <verb> — <extra>"
 */

export const NOTIFY_OUTCOMES = {
  start: ["🚀", "started"],
  done: ["✅", "done"],
  failed: ["⚠️", "failed"],
};

/**
 * @param {{id:string, title:string}} t
 * @param {"start"|"done"|"failed"} outcome — unknown values fall back to the failed format
 * @param {string} extra
 * @returns {string}
 */
export function notifyMessage(t, outcome, extra) {
  const [emoji, verb] = NOTIFY_OUTCOMES[outcome] || NOTIFY_OUTCOMES.failed;
  return `${emoji} Todo ${t.id} "${t.title}" ${verb} — ${extra}`;
}
