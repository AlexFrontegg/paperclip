import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

test('passes when a PR moves the target branch tip after the new migrations with the same SQL', () => {
  const result = checkMigrationOrder(
    [migration('0431_upstream'), migration('0432_fork_indexes')],
    [migration('0432_upstream'), migration('0433_upstream'), migration('0434_fork_indexes')],
    new Set([migration('0432_fork_indexes')]),
  );

  assert.equal(result.passed, true);
  assert.match(result.message, /follow .*0431_upstream\.sql/);
});

test('passes when a PR replaces the target branch tip with an upstream migration with the same SQL', () => {
  const result = checkMigrationOrder(
    [migration('0451_upstream'), migration('0452_fork_indexes')],
    [migration('0452_upstream'), migration('0456_upstream_indexes')],
    new Set([migration('0452_fork_indexes')]),
  );

  assert.equal(result.passed, true);
});

test('still fails when a PR that moves the tip also inserts below the remaining history', () => {
  const result = checkMigrationOrder(
    [migration('0431_upstream'), migration('0432_fork_indexes')],
    [migration('0430_from_stale_branch'), migration('0434_fork_indexes')],
    new Set([migration('0432_fork_indexes')]),
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0431_upstream\.sql/);
  assert.match(result.message, /0430_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0434_fork_indexes\.sql/);
});
