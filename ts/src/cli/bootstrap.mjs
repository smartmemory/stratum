import { registerHooks } from "node:module";
import { resolve } from "./ts-resolver.mjs";

// `registerHooks` (synchronous, in-thread) replaces the deprecated
// loader-based `register()` (DEP0205). The resolver only remaps specifiers,
// so an in-thread synchronous hook is behaviorally equivalent here.
registerHooks({ resolve });
