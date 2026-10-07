import { execFile } from "node:child_process";

/** Sends the headline wherever it's configured. Failures are logged, never fatal. */
export async function notify(title: string, message: string, reportPath: string): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (process.platform === "darwin") {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
    tasks.push(new Promise((resolve) => execFile("osascript", ["-e", script], () => resolve(null))));
  }

  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    tasks.push(
      fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { title, tags: "briefcase" },
        body: message,
      }),
    );
  }

  const slack = process.env.SLACK_WEBHOOK_URL;
  if (slack) {
    tasks.push(
      fetch(slack, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${title}*\n${message}\n_Report: ${reportPath}_` }),
      }),
    );
  }

  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === "rejected") console.warn(`notification failed: ${(r.reason as Error).message}`);
  }
}
