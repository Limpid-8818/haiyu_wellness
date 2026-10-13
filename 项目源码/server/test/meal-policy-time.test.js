import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env,{DB_DRIVER:'sqlite',DB_PATH:':memory:',DEMO_SEED:'1',LLM_API_KEY:'',LLM_BASE_URL:'',LLM_MODEL:'',ENVIRONMENT_MODE:'unavailable',ENVIRONMENT_LIVE:'0',BUSINESS_CLOCK_NOW:'2030-01-01T01:14:00.000Z'});
const {app}=await import('../src/app.js');const {db,transaction,hashPassword,now}=await import('../src/db.js');
await (await import('../src/demo-team.js')).initializeDemoTeam({database:db,transact:transaction,hashPassword,stamp:now()});
const {createBusinessClock}=await import('../src/clock.js');const {mealDeliveryTiming}=await import('../src/meal-policy.js');
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`,tokens={};
test.after(async()=>{await new Promise(r=>server.close(r));await db.close()});
async function call(role,route,method='GET',body,expected=200,key){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(tokens[role]?{Authorization:`Bearer ${tokens[role]}`}:{}) ,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();assert.equal(r.status,expected,`${method} ${route}: ${JSON.stringify(d)}`);return d;}
for(const [role,username] of [['admin','admin_demo'],['clinician','staff_demo'],['dietitian','dietitian_demo']])tokens[role]=(await call(null,'/auth/login','POST',{username,password:'staff2026',role:'staff'})).token;
let serial=0;
async function guest(profile={}){const role='g'+(++serial),phone='199000078'+String(serial).padStart(2,'0');const d=await call(null,'/auth/register','POST',{name:'合成餐单测试'+serial,phone,password:'Synthetic-meal-only-123',confirmPassword:'Synthetic-meal-only-123'},201);tokens[role]=d.token;await call('admin',`/dean/guests/${d.user.id}/stay`,'PATCH',{roomNo:'合成',checkIn:'2030-01-01',checkOut:'2030-01-04',stayPlan:'three_night'});const staff=await call('admin','/dean/staff');for(const job of ['clinician','dietitian'])await call('admin',`/dean/guests/${d.user.id}/assignments`,'POST',{staffId:staff.find(x=>x.jobType===job).id},201);await report(role,profile);return {role,id:d.user.id};}
const none={status:'none',items:[]};
async function report(role,override){const old=await call(role,'/me/health-profile');const d=await call(role,'/me/health-intakes','POST',{baseProfileVersion:old.profileVersion,profile:{chronic:none,medications:none,allergies:none,dietaryRestrictions:none,mobility:{status:'independent',details:'合成可独立活动'},sleep:{status:'reported',details:'正常'},skin:{status:'reported',details:'完整'},audienceTags:none,...override}},201);await call('clinician',`/staff/health-intakes/${d.pendingIntakes[0].id}/confirm`,'POST',{baseProfileVersion:old.profileVersion});}
const generate=(role,date,expected=201)=>call(role,'/meals/menus','POST',{businessDate:date},expected);
const selection=menu=>menu.items.map(i=>[i.mealType,i.slot,i.dish?.id]);

test('three-date native menus vary within actual compatible catalog, independently of generation order and remain stable',async()=>{
  const a=await guest(),b=await guest();const dates=['2030-01-01','2030-01-02','2030-01-03'],views={};
  for(const date of [...dates].reverse())views[date]=await generate(a.role,date);
  for(const date of dates){const view=views[date],other=await generate(b.role,date);assert.deepEqual(selection(other),selection(view));assert.equal(view.menu.ruleBasis.recommendationPolicy.version,'catalog_rotation_v1');assert.equal(new Set(view.items.filter(i=>i.slot==='main').map(i=>i.dish.id)).size,3);
    for(const i of view.items){assert.ok(i.dish.mealTypes.includes(i.mealType));assert.equal(i.dish.slot,i.slot);assert.equal(i.dish.supplyStatus,'demo_available');assert.match(i.selectionReason,/目录规则推荐/);assert.match(i.dish.name,/演示/)}
    assert.deepEqual(selection(await generate(a.role,date,200)),selection(view));assert.equal((await generate(a.role,date,200)).menu.id,view.menu.id);assert.equal((await call(a.role,`/meals/menu?date=${date}`)).menu.version,1);
  }
  assert.equal(new Set(dates.map(d=>JSON.stringify(selection(views[d])))).size,3);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM meal_menus WHERE guest_id=?').get(a.id)).n,3);
});

test('manual compatible replacement persists its reason/version; wrong meal and slot alternatives are rejected',async()=>{
  const g=await guest();let view=await generate(g.role,'2030-01-01');const item=view.items.find(i=>i.mealType==='lunch'&&i.slot==='main');const choice=item.eligibleReplacements[0];assert.ok(choice);
  await call(g.role,`/meals/menus/${view.menu.id}/items/${item.id}`,'PATCH',{version:1,dishId:'dish-pumpkin-congee',reason:'午餐不适用'},400);
  await call(g.role,`/meals/menus/${view.menu.id}/items/${item.id}`,'PATCH',{version:1,dishId:'dish-broccoli',reason:'餐位不适用'},400);
  await call(g.role,`/meals/menus/${view.menu.id}/items/${item.id}`,'PATCH',{version:1,dishId:choice.id,reason:'合成人工选择替代'},200);
  view=await generate(g.role,'2030-01-01',200);assert.equal(view.menu.version,2);assert.equal(view.items.find(i=>i.id===item.id).dish.id,choice.id);assert.match(view.items.find(i=>i.id===item.id).selectionReason,/合成人工选择替代/);
  assert.equal((await call(g.role,'/meals/menu?date=2030-01-01')).menu.id,view.menu.id);
});

test('insufficient catalog repeats with explanation; explicit and unknown restrictions never become diversity exceptions',async()=>{
  const g=await guest({allergies:{status:'reported',items:['海鲜','鸡蛋']}});const view=await generate(g.role,'2030-01-01');assert.ok(view.items.every(i=>!i.dish||!i.dish.allergens.some(x=>['fish','shrimp','egg'].includes(x))));
  await report(g.role,{allergies:{status:'reported',items:['神秘食物']}});const blocked=await generate(g.role,'2030-01-02');assert.ok(blocked.items.every(i=>!i.dish&&!i.eligibleReplacements.length));
  const sparse=await guest();const rows=await db.prepare("SELECT id,supply_status FROM dishes WHERE slot='main'").all();
  try{await db.prepare("UPDATE dishes SET supply_status='unavailable' WHERE slot='main' AND id!='dish-chicken-rice'").run();const m=await generate(sparse.role,'2030-01-01');assert.equal(new Set(m.items.filter(i=>i.slot==='main').map(i=>i.dish.id)).size,1);assert.ok(m.items.filter(i=>i.slot==='main').slice(1).every(i=>/候选不足.*重复/.test(i.selectionReason)));}finally{for(const row of rows)await db.prepare('UPDATE dishes SET supply_status=? WHERE id=?').run(row.supply_status,row.id)}
});

test('late and future orders have honest unknown ETA, Shanghai serving/UTC and same-order staff fulfillment remain immutable',async()=>{
  const g=await guest();const menus={};for(const d of ['2030-01-01','2030-01-02'])menus[d]=await generate(g.role,d);
  for(const [date,meal] of [['2030-01-01','breakfast'],['2030-01-01','lunch'],['2030-01-02','breakfast']]){
    const m=menus[date],body={menuId:m.menu.id,businessDate:date,mealType:meal,version:1},key=date+meal;const placed=await call(g.role,'/meals/orders','POST',body,201,key);const order=placed.order;
    assert.equal(order.expectedDeliveryAt,null);assert.equal(order.deliveryEstimateStatus,'unknown');assert.match(order.expectedDeliveryNote,/未确定/);assert.equal(order.regularServingAt,mealDeliveryTiming(date,meal).regularServingAt);
    assert.equal((await call(g.role,'/meals/orders','POST',body,200,key)).order.id,order.id);
    const staff=(await call('dietitian',`/staff/meals/orders?date=${date}`)).find(x=>x.id===order.id);assert.ok(staff);for(const k of ['createdAt','regularServingAt','expectedDeliveryAt','deliveryEstimateStatus'])assert.equal(staff[k],order[k]);
    await call('dietitian',`/staff/meals/orders/${order.id}/status`,'PATCH',{status:'preparing'});const done=await call('dietitian',`/staff/meals/orders/${order.id}/status`,'PATCH',{status:'delivered'});await call('dietitian',`/staff/meals/orders/${order.id}/status`,'PATCH',{status:'preparing'},409);const read=(await call(g.role,`/meals/orders?date=${date}`)).find(x=>x.id===order.id);assert.equal(read.deliveredAt,done.order.deliveredAt);assert.equal(read.createdAt,order.createdAt);
    const sql=await db.prepare('SELECT created_at,expected_delivery_at,delivered_at FROM meal_orders WHERE id=?').get(order.id);assert.equal(new Date(sql.expected_delivery_at).toISOString(),order.regularServingAt);assert.equal(new Date(sql.created_at).toISOString(),order.createdAt);
  }
  const before=createBusinessClock({now:()=>new Date('2029-12-31T15:59:59Z')}),after=createBusinessClock({now:()=>new Date('2029-12-31T16:00:01Z')});assert.equal(before.dateKey(),'2029-12-31');assert.equal(after.dateKey(),'2030-01-01');assert.equal(mealDeliveryTiming(after.dateKey(),'breakfast').regularServingAt,'2030-01-01T00:00:00.000Z');
});
