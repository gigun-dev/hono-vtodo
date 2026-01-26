import { Hono } from "hono";

import { registerCaldavRoutes } from "./caldav/handlers";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => c.text("CalDAV VTODO server is running."));

registerCaldavRoutes(app);

export default app;
