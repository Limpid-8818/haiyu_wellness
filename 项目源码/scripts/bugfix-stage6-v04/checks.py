import os,sys,signal,subprocess,json,pathlib
signal.alarm(60)
task,name=sys.argv[1:3];root=pathlib.Path.cwd();out=root/'output/playwright/bugfix-stage6'/task/'checks';out.mkdir(parents=True,exist_ok=True)
command=sys.argv[3:];env={'PATH':os.environ['PATH'],'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','DB_DRIVER':'sqlite','DB_PATH':':memory:','DEMO_SEED':'0','LLM_API_KEY':'','LLM_BASE_URL':'','LLM_MODEL':'','ENVIRONMENT_MODE':'unavailable','ENVIRONMENT_LIVE':'0','STAGE25_SCHEDULER_ENABLED':'0','HAIYU_RESOURCE_MANAGED':'1'}
runner=['node','scripts/resources/resource-runner.js','--task-id',task,'--audit-root',str(root/'output/resource-audit/bugfix-stage6'/task/'runtime'),'--kind','test','--name',name,'--timeout-ms','45000','--lease-ms','900000','--log-bytes','8388608','--directory-bytes','536870912','--']+command
p=subprocess.run(runner,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=55);(out/(name+'.log')).write_bytes(p.stdout)
try:r=json.loads(p.stdout.decode()[p.stdout.decode().index('{'):]);child=r.get('result',r.get('task',{}));summary={'exitCode':p.returncode,'command':runner,'result':r.get('status'),'cleanup':r.get('cleanup'),'outputTail':r.get('outputTail','')}
except Exception:summary={'exitCode':p.returncode,'command':runner,'tail':p.stdout.decode()[-2000:]}
(out/(name+'.json')).write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps({'exitCode':p.returncode,'log':str(out/(name+'.log')),'tail':summary.get('outputTail',summary.get('tail',''))[-450:]},ensure_ascii=False));sys.exit(p.returncode)
