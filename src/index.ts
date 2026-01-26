import { Hono } from "hono";

import { registerCaldavRoutes } from "./caldav/handlers";
import type { CaldavEnv } from "./types/env";

const app = new Hono<{ Bindings: CaldavEnv }>();

app.get("/", (c) => c.text("CalDAV VTODO server is running."));

registerCaldavRoutes(app);

export default app;
