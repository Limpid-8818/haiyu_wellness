import test from 'node:test';
import assert from 'node:assert/strict';
import { collaborationState, healthDisclosure } from '../src/agent-presentation.js';
import { emptyHealthProfile } from '../src/health-profile.js';

test('configuration cannot imply a completed run; incomplete domains remain distinguishable', () => {
  assert.equal(collaborationState(null), 'not_run');
  assert.equal(collaborationState({status:'running'}), 'running');
  assert.equal(collaborationState({status:'failed'}), 'failed');
  assert.equal(collaborationState({status:'completed',collaboration:{gaps:[{domain:'nutrition'}]}}), 'partial_failure');
  assert.equal(collaborationState({status:'completed',collaboration:{coordinatorError:'GRAPH_TOKEN_BUDGET'}}), 'partial_failure');
  assert.equal(collaborationState({status:'completed',collaboration:{gaps:[],coordinatorError:null}}), 'completed');
});

test('verified mobility and sleep never imply six missing health domains are negative', () => {
  const profile = emptyHealthProfile();
  profile.mobility = {status:'independent',details:'可独立行走'};
  profile.sleep = {status:'reported',details:'睡眠一般'};
  const result = healthDisclosure(profile,1,'synthetic');
  for (const label of ['慢病史','长期用药说明','过敏源','饮食忌口','皮肤状况','客群标签']) assert.ok(result.text.includes(label));
  assert.match(result.text,/未知不代表没有/);
  assert.match(result.text,/行动能力、睡眠情况/);
  assert.equal(result.source.id,'synthetic');
  assert.match(result.text,/版本 1/);
});
