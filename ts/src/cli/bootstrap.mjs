import { register } from "node:module";

register(new URL("./ts-resolver.mjs", import.meta.url));
