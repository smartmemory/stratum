// Preload only for subprocess integration tests; never use the user's guard store.
import { setGuardsDir } from '../../src/guard/store.ts';
if (!process.env.STRATUM_TEST_GUARD_ROOT) throw new Error('isolated guard root missing');
setGuardsDir(process.env.STRATUM_TEST_GUARD_ROOT);
// The stdout/planning probe tests real lock files, not macOS ps access (denied
// in the OS sandbox). Reuse the guard tests' injectable identity boundary.
import { ResourceLockManager } from '../../src/guard/lock.ts';
import { setGuardLockingForTests } from '../../src/guard/transition.ts';
const locks = new ResourceLockManager({ processIdentity: async pid => ({ alive: true, startTime: `fixture-${pid}` }) });
setGuardLockingForTests(
  (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
  (resourceId, token) => locks.assertStillHeld(resourceId, token),
);
