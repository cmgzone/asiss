import { Skill } from '../core/skills';
import os from 'os';

export class SystemSkill implements Skill {
  name = 'system_info';
  description = 'Get system information (hostname, platform, uptime)';

  async execute() {
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem()
    };
  }
}

export class TimeSkill implements Skill {
  name = 'current_time';
  description = 'Get the current system time';

  async execute() {
    return {
      iso: new Date().toISOString(),
      local: new Date().toLocaleString()
    };
  }
}
