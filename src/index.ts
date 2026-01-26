import { Hono } from "hono";
import { Client } from "pg";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => {
	return c.text("Hello Hono!");
});

app.get("/tables", async (c) => {
	const client = new Client({
		connectionString: c.env.HYPERDRIVE.connectionString,
	});

	await client.connect();

	try {
		const result = await client.query("SELECT * FROM pg_tables");
		return c.json({ result: result.rows });
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : error },
			{ status: 500 },
		);
	} finally {
		await client.end();
	}
});

export default app;
