'use strict';

/**
 * Background job registration (#1367).
 *
 *   - importing app starts no timers or cron tasks
 *   - startJobs() is a no-op unless RUN_JOBS=true
 *   - runExclusive() skips a tick while the previous run is still going
 *   - every job module that exists is either scheduled or a documented non-job
 *
 * Run with `npm run test:handles` to have Jest's --detectOpenHandles confirm
 * nothing is left running after importing app.
 */

const fs = require('fs');
const path = require('path');

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

const cron = require('node-cron');
const logger = require('../src/logger');
const { JOBS, startJobs, runExclusive, jobsEnabled } = require('../src/jobs');

describe('importing app', () => {
  it('schedules no cron tasks and no intervals', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    cron.schedule.mockClear();

    jest.isolateModules(() => {
      require('../src/app');
    });

    expect(cron.schedule).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe('startJobs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    cron.schedule.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([undefined, 'false', '1', 'TRUE'])('does nothing when RUN_JOBS=%s', (value) => {
    const run = jest.fn();
    const stop = startJobs({ env: { RUN_JOBS: value }, jobs: [{ name: 'x', intervalMs: 10, runOnStart: true, run }] });

    jest.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(jobsEnabled({ RUN_JOBS: value })).toBe(false);
    stop();
  });

  it('schedules cron jobs in UTC and interval jobs when RUN_JOBS=true, and stops them', async () => {
    const intervalRun = jest.fn().mockResolvedValue();
    const stop = startJobs({
      env: { RUN_JOBS: 'true' },
      jobs: [
        { name: 'cron-job', cron: '0 * * * *', run: jest.fn() },
        { name: 'interval-job', intervalMs: 1000, run: intervalRun },
      ],
    });

    expect(cron.schedule).toHaveBeenCalledWith('0 * * * *', expect.any(Function), expect.objectContaining({ timezone: 'UTC' }));

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(intervalRun).toHaveBeenCalledTimes(1);

    stop();
    jest.advanceTimersByTime(5000);
    expect(intervalRun).toHaveBeenCalledTimes(1);
    expect(cron.schedule.mock.results[0].value.stop).toHaveBeenCalled();
  });

  it('skips jobs whose enabled() returns false', () => {
    const run = jest.fn();
    const stop = startJobs({
      env: { RUN_JOBS: 'true' },
      jobs: [{ name: 'off', intervalMs: 10, runOnStart: true, enabled: () => false, run }],
    });
    jest.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
    stop();
  });
});

describe('runExclusive', () => {
  it('skips a run while the previous one is still in progress', async () => {
    let finish;
    const run = jest.fn(() => new Promise((resolve) => { finish = resolve; }));

    const first = runExclusive('slow', run);
    await expect(runExclusive('slow', run)).resolves.toBe('skipped');
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await expect(first).resolves.toBe('completed');
    await expect(runExclusive('slow', jest.fn())).resolves.toBe('completed');
  });

  it('logs failures with duration instead of throwing', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await expect(runExclusive('boom', () => Promise.reject(new Error('nope')))).resolves.toBe('failed');
    expect(errorSpy).toHaveBeenCalledWith(
      '[jobs] Job failed',
      expect.objectContaining({ job: 'boom', error: 'nope', durationMs: expect.any(Number) })
    );
    errorSpy.mockRestore();
  });
});

describe('job registry', () => {
  it('has unique names and exactly one schedule per job', () => {
    const names = JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const job of JOBS) {
      expect(Boolean(job.cron) !== Boolean(job.intervalMs)).toBe(true);
      expect(typeof job.run).toBe('function');
    }
  });

  it('schedules the previously unstarted confirm-payments job', () => {
    expect(JOBS.map((j) => j.name)).toContain('confirm-payments');
  });

  it('every module in src/jobs is registered (no orphaned jobs)', () => {
    const registrySource = fs.readFileSync(path.join(__dirname, '../src/jobs/index.js'), 'utf8');
    const modules = fs
      .readdirSync(path.join(__dirname, '../src/jobs'))
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .map((f) => f.replace(/\.js$/, ''));
    const unregistered = modules.filter((m) => !registrySource.includes(`require('./${m}')`));
    expect(unregistered).toEqual([]);
  });
});
