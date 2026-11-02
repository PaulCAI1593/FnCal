// TZ=America/Santiago 子进程里的「午夜跳变」防护断言。
//
// 由 tests/date-utils.test.js 用 spawnSync 启动：vitest 的隔离环境在启动时定下
// 本机时区，运行期再改 process.env.TZ 不生效，所以把同一组断言放进独立进程，
// 用环境变量 TZ 启动。退出码 0 = 通过，非 0 = 断言失败（assert 抛错）。
import assert from 'node:assert/strict';
import { startOfDay, minutesIntoDay, roundToNearestMinutes } from '../../src/js/date-utils.js';

// Chile's spring-forward lands AT midnight: on 2022-09-11 (a fixed, historical
// transition) clocks jumped 00:00 -> 01:00 in Santiago, so startOfDay can only
// land on 01:00. Building times off that with a bare setMinutes shifted the
// whole day one hour; minutesIntoDay must not.
assert.equal(
  process.env.TZ,
  'America/Santiago',
  'fixture must be started with TZ=America/Santiago',
);

const day = new Date(2022, 8, 11, 12, 0);
assert.equal(startOfDay(day).getHours(), 1, 'startOfDay lands on 01:00 (the trap)');

const at = minutesIntoDay(day, 10 * 60 + 30);
assert.equal(at.getHours(), 10, 'minutesIntoDay keeps the wall clock (hour)');
assert.equal(at.getMinutes(), 30, 'minutesIntoDay keeps the wall clock (minute)');
assert.equal(at.getDate(), 11, 'minutesIntoDay stays on the same calendar day');

// …and the callers that delegate to it: rounding stays on the wall clock.
const rounded = roundToNearestMinutes(new Date(2022, 8, 11, 10, 20), 30);
assert.equal(rounded.getHours(), 10);
assert.equal(rounded.getMinutes(), 30);
assert.equal(rounded.getDate(), 11);
