'use strict';
const crypto = require('node:crypto');

// ECS runs the trusted sandbox controller in its own systemd service. The web
// service stays unprivileged and shares only fixed service authentication keys.
function configureAgent(env = process.env) {
  const external = env.TEACHER_AGENT_MODE === 'ecs-external';
  const enabled = ['fc-internal', 'ecs-external'].includes(env.TEACHER_AGENT_MODE) && env.ENABLE_TEACHER_CHAT === '1';
  if (enabled) {
    if (env.OSS_SINGLE_WRITER !== '1') throw Error('Internal Agent requires single-writer OSS');
    if (external) {
      for (const name of ['AGENT_SIGNING_KEY', 'AGENT_TOOL_VERIFY_KEY', 'AGENT_PERSISTENCE_KEY'])
        if (!env[name] || env[name].length < 32) throw Error(name + ' is required for the external Agent');
    } else {
      if (!env.DEEPSEEK_API_KEY) throw Error('DEEPSEEK_API_KEY is required');
      for (const name of ['AGENT_SIGNING_KEY', 'AGENT_TOOL_VERIFY_KEY', 'AGENT_PERSISTENCE_KEY'])
        env[name] = crypto.randomBytes(32).toString('hex');
    }
    env.AGENT_BASE_URL = 'http://127.0.0.1:9181';
    env.TEACHING_DEPLOYMENT_ID ||= 'cc_dify_mcp-hangzhou';
  }
  return { enabled, external: enabled && external };
}
module.exports = { configureAgent };
