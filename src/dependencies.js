/**
 * Dependency rules. A link "A depends on B" means A waits for B.
 *
 * Kept free of the database so the loop check can be tested on its own and
 * reasoned about in one place.
 */

/**
 * Looks for a loop that saving `taskSrNo -> dependsOn` would create.
 *
 * `edges` is every existing link as [task, dependsOn]. The task's own existing
 * links are ignored, because saving replaces them. A loop exists when the task
 * can be reached again by following "waits for" links from one of its new
 * dependencies.
 *
 * Returns null when there is no loop, otherwise the loop as a list of Sr Nos
 * starting and ending with `taskSrNo`, e.g. [3, 5, 8, 3].
 */
function findLoop(taskSrNo, dependsOn, edges) {
  const next = new Map();
  for (const [from, to] of edges) {
    if (from === taskSrNo) continue;
    if (!next.has(from)) next.set(from, []);
    next.get(from).push(to);
  }
  for (const start of dependsOn) {
    if (start === taskSrNo) return [taskSrNo, taskSrNo];
    // Breadth-first, remembering how each task was reached, so the message
    // can name the shortest loop rather than just say there is one.
    const cameFrom = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift();
      for (const to of next.get(at) || []) {
        if (to === taskSrNo) {
          const path = [at];
          for (let p = cameFrom.get(at); p !== null; p = cameFrom.get(p)) path.unshift(p);
          return [taskSrNo, ...path, taskSrNo];
        }
        if (!cameFrom.has(to)) {
          cameFrom.set(to, at);
          queue.push(to);
        }
      }
    }
  }
  return null;
}

module.exports = { findLoop };
