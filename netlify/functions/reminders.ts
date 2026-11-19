import type { Config } from '@netlify/functions';
import { dispatchDueReminders } from '../../server/lib/notify.js';

/** Scheduled: turn due task reminders into in-app notifications. */
export default async () => {
  const n = await dispatchDueReminders();
  console.log(JSON.stringify({ level: 'info', job: 'reminders', created: n }));
};

export const config: Config = { schedule: '*/15 * * * *' };
