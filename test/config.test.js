import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSimpleYaml } from '../src/config.js';

describe('knot.yml', () => {
    it('reads a list of plain values, which is how filters are written', () => {
        const parsed = parseSimpleYaml(`
filters:
  statuses:
    - inbox
    - ready
  tags:
    - development
`);

        assert.deepEqual(parsed.filters.statuses, ['inbox', 'ready']);
        assert.deepEqual(parsed.filters.tags, ['development']);
    });

    it('still reads a list of maps, which is how several agents are written', () => {
        const parsed = parseSimpleYaml(`
agents:
  - agent: qa-demo
    workspace: demo
  - agent: builder
    workspace: demo
`);

        assert.equal(parsed.agents.length, 2);
        assert.equal(parsed.agents[1].agent, 'builder');
    });

    it('reads the whole automation block from the product decision', () => {
        const parsed = parseSimpleYaml(`
mode: auto

automation:
  tasks:
    enabled: true

    schedule:
      timezone: America/Argentina/Buenos_Aires
      from: "08:00"
      until: "23:59"

    notify:
      agent: builder

    filters:
      statuses:
        - inbox
        - ready
      tags:
        - development
      projects:
        - demo
      assignment:
        only_assigned_to_me: true
`);

        assert.equal(parsed.mode, 'auto');
        assert.equal(parsed.automation.tasks.enabled, true);
        assert.equal(parsed.automation.tasks.schedule.from, '08:00');
        assert.equal(parsed.automation.tasks.notify.agent, 'builder');
        assert.deepEqual(parsed.automation.tasks.filters.projects, ['demo']);
        assert.equal(parsed.automation.tasks.filters.assignment.only_assigned_to_me, true);
    });

    it('leaves automation absent when the file says nothing, which must never mean yes', () => {
        const parsed = parseSimpleYaml('agent: builder\n');

        assert.equal(parsed.automation, undefined);
        assert.equal(parsed.mode, undefined);
    });
});
