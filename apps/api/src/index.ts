import { OpenAPIHono } from "@hono/zod-openapi";
import { registerHealth } from "./routes/health";

export const app = new OpenAPIHono();
registerHealth(app);

export default app;
