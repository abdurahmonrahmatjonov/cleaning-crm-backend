import { config } from '../config.js';

const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// sv-SE already renders "YYYY-MM-DD HH:MM:SS"
export const nowDateTime = () => fmt.format(new Date());
export const today = () => nowDateTime().slice(0, 10);
