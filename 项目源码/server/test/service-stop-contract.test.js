import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isCleanApiStop} from '../../scripts/bugfix-stage2/stop-contract.js';
test('planned graceful API stop accepts stopped and exited only with every exact PID confirmed',()=>{
  const complete={status:'stopped',exitCode:0,signal:null,timedOut:false,pids:[{exitConfirmed:true}]};
  assert.equal(isCleanApiStop(complete),true);
  assert.equal(isCleanApiStop({...complete,status:'exited'}),true);
  for(const diff of [{status:'running'},{exitCode:1},{signal:'SIGKILL'},{timedOut:true},{pids:[]},{pids:[{exitConfirmed:false}]},{pids:undefined}]){
    assert.equal(isCleanApiStop({...complete,...diff}),false);
  }
});
