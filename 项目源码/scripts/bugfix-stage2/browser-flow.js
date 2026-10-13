export async function prepareJourney(page, cfg, evidence) {
  const check = (ok, label) => { if (!ok) throw new Error(label); evidence.assertions.push(label); };
  const tokens = {};
  const call = async (role, route, method = 'GET', body, expected = 200, key) => {
    const response = await page.request.fetch(cfg.web + '/api' + route, { method, headers: { 'Content-Type': 'application/json',
      ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { data: body }) });
    const data = await response.json(); check(response.status() === expected, `${role || 'public'} ${method} ${route} HTTP${expected}`);
    evidence.http.push({ role, route, method, status: response.status(), code: data.code || null }); return data;
  };
  const creds = { administrator: ['admin_demo','staff2026','staff'], clinician: ['staff_demo','staff2026','staff'],
    coach: ['coach_demo','staff2026','staff'], therapist: ['therapist_demo','staff2026','staff'], dietitian: ['dietitian_demo','staff2026','staff'], dean: ['dean_demo','dean2026','dean'] };
  for (const [job, [username,password,role]] of Object.entries(creds)) tokens[job] = (await call(null, '/auth/login', 'POST', { username,password,role })).token;
  const member = await call('administrator','/dean/staff','POST',{ username:'stage2_created_coach',password:'Synthetic-stage2-only-123',name:'合成新增教练',jobType:'coach',phone:'' },201);
  const beforeCount = (await call('administrator','/dean/staff')).length;
  await call('administrator','/dean/staff','POST',{ username:'stage2_created_coach',password:'Synthetic-stage2-only-123',name:'合成新增教练',jobType:'coach' },409);
  check((await call('administrator','/dean/staff')).length === beforeCount, '重复员工创建未增加账号');
  const registered = await call(null,'/auth/register','POST',{ name:'阶段2合成旅程客人',phone:'19900006501',password:'Synthetic-stage2-only-123',confirmPassword:'Synthetic-stage2-only-123' },201);
  tokens.guest = registered.token; const guestId = registered.user.id;
  const last = new Date(cfg.date+'T12:00:00Z'); last.setUTCDate(last.getUTCDate()+3);
  await call('administrator',`/dean/guests/${guestId}/stay`,'PATCH',{roomNo:'合成房间',checkIn:cfg.date,checkOut:last.toISOString().slice(0,10),stayPlan:'three_night'});
  const staff = await call('administrator','/dean/staff');
  const staffIds = {};
  for (const job of ['administrator','clinician','coach','therapist','dietitian']) {
    staffIds[job] = staff.find(item => item.username === creds[job][0]).id;
    await call('administrator',`/dean/guests/${guestId}/assignments`,'POST',{staffId:staffIds[job]},201);
  }
  check((await call('administrator',`/dean/guests/${guestId}/assignments`)).length === 5,'管理员登记五岗负责关系');
  check((await call('guest','/me')).profile.room_no === '合成房间','客人回读管理员入住登记');
  const none = {status:'none',items:[]};
  const submitted = await call('guest','/me/health-intakes','POST',{baseProfileVersion:0,profile:{chronic:none,allergies:{status:'reported',items:['空气']},dietaryRestrictions:none,skin:{status:'reported',details:'皮肤完好'}}},201);
  await call('clinician',`/staff/health-intakes/${submitted.pendingIntakes[0].id}/confirm`,'POST',{baseProfileVersion:0});
  const request = await call('guest','/meals/restriction-review','POST',{});
  await call('clinician',`/staff/meal-restriction-reviews/${request.review.id}/resolve`,'POST',{decisions:[{classification:'non_food'}],note:'医护与合成客人明确核对为空气环境描述，原文保持'});
  await call('clinician',`/staff/guests/${guestId}/advice`,'POST',{title:'阶段2合成医护记录',content:'合成事务回读，非医疗指导',priority:'normal'},201);
  check((await call('guest','/me')).advice.some(row=>row.title==='阶段2合成医护记录'),'客人回读医护发布记录');
  await call('coach',`/staff/guests/${guestId}/advice`,'POST',{title:'越权检查',content:'非医护不能发布'},403);
  tokens.outsider=(await call(null,'/auth/login','POST',{username:'stage2_created_coach',password:'Synthetic-stage2-only-123',role:'staff'})).token;
  await call('outsider',`/staff/guests/${guestId}`,'GET',undefined,403);
  const menu = await call('guest','/meals/menus','POST',{businessDate:cfg.date},201);
  const order = await call('guest','/meals/orders','POST',{menuId:menu.menu.id,businessDate:cfg.date,mealType:'breakfast',version:menu.menu.version},201,'stage2-order');
  const coachSlots = await call('guest',`/projects/stage2-indoor-exercise/slots?date=${cfg.date}`);
  const therapySlots = await call('guest',`/projects/project-sea-mud/slots?date=${cfg.date}`);
  const reservations = {};
  for (const [job, slot, target] of [['coach',coachSlots.slots.find(row=>row.bookable),'coach'],['therapist',therapySlots.slots.find(row=>row.bookable),'therapist'],['coach',coachSlots.slots.filter(row=>row.bookable)[2],'noShow']]) {
    check(Boolean(slot),`真实产品筛选可预约时段 ${target}`);
    const booked = await call('guest','/reservations','POST',{slotId:slot.id},201,`stage2-book-${target}`);
    reservations[target]=booked.reservation;
    await call('administrator',`/admin/operations/slots/${slot.id}/assignments`,'POST',{staffId:staffIds[job],jobType:job},201);
    await call(job,`/staff/schedule/${booked.reservation.id}/execution`,'POST',{status:'completed',note:'未结束拒绝检查'},409);
  }
  await call('coach',`/staff/schedule/${reservations.therapist.id}/execution`,'POST',{status:'completed',note:'时段岗位不符'},403);
  evidence.objects={guestId,staffIds,createdStaffId:member.id,orderId:order.order.id,reservations};
  return {tokens,call,creds,guestId,reservations,staffIds,orderId:order.order.id};
}

export async function finishJourney(page,cfg,evidence,state) {
  const {call,guestId,reservations,staffIds,orderId,creds}=state;
  const check=(ok,label)=>{if(!ok)throw new Error(label);evidence.assertions.push(label)};
  const login=async(job)=>{
    if(await page.getByRole('button',{name:'退出登录',exact:true}).count())await page.getByRole('button',{name:'退出登录',exact:true}).click();
    else await page.goto(cfg.web);
    const [username,password,role]=job==='guest'?['19900006501','Synthetic-stage2-only-123','guest']:creds[job];
    await page.getByRole('button',{name:role==='guest'?/^我是客人/:role==='dean'?/^院长管理入口/:/^我是工作人员/}).first().click();
    await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'进入工作区　→',exact:true}).click();await page.locator('.side-nav').waitFor();
    check((await page.locator('.workspace-label').innerText()).includes(job==='guest'?'客人':job==='dean'?'院长':({administrator:'管理员',clinician:'医护',coach:'教练',therapist:'理疗师',dietitian:'配餐员'})[job]),`实际网页登录 ${job}`);
  };
  const snap=async(name,selector)=>{const file=cfg.out+'/'+name+'.png';if(selector)await page.locator(selector).first().screenshot({path:file});else await page.screenshot({path:file});evidence.screenshots.push(file)};
  await login('administrator'); await page.locator('.side-nav').getByRole('button',{name:'员工账号',exact:true}).click();
  await page.getByText('合成新增教练',{exact:true}).waitFor(); await snap('01-admin-employees');
  await login('clinician'); await page.locator('.side-nav').getByRole('button',{name:'我负责的客人',exact:true}).click();
  await page.locator('.guest-row').filter({hasText:'阶段2合成旅程客人'}).click();
  await page.getByText('处理状态：已人工核对',{exact:false}).waitFor(); await snap('02-clinician-reviewed','.meal-restriction-review');
  await login('guest');await page.locator('.side-nav').getByRole('button',{name:'日程',exact:true}).click();
  await page.locator(`[data-testid="q24-appointment-${reservations.coach.id}"]`).waitFor();
  for(const target of ['coach','therapist']){
    const card=page.locator(`[data-testid="q24-appointment-${reservations[target].id}"]`);
    await card.getByRole('button',{name:'签到',exact:true}).click();await card.locator('.q24-feedback-form').waitFor();
    await card.locator('select').selectOption('comfortable');await card.locator('textarea').fill('阶段2合成服务感受');
    await card.getByRole('button',{name:'保存感受',exact:true}).click();
    await card.getByText(/反馈编号 .*第 1 版/).waitFor();
  }
  for(const job of ['coach','therapist']){
    await login(job);await page.getByRole('heading',{name:job==='coach'?'教练每日安排':'理疗师工作安排',exact:true}).waitFor();
    await page.locator('.side-nav').getByRole('button',{name:job==='coach'?'每日安排':'理疗工作台',exact:true}).click();
    const row=page.locator(`[data-reservation-id="${reservations[job].id}"]`);
    await row.getByText(/客人已签到/).waitFor();check((await row.innerText()).includes('客人反馈第 1 版'),'岗位读取同预约签到/反馈 '+job);
    await row.getByLabel('服务工作说明').fill(job+'阶段2合成服务完成');await row.getByRole('button',{name:'记录服务完成',exact:true}).click();
    await row.getByText(/服务已完成/).waitFor();await snap('03-'+job+'-completed');
    const guest=(await call('guest','/me/checkins')).items.find(item=>item.reservationId===reservations[job].id);
    const staff=(await call(job,`/staff/schedule?date=${cfg.date}`)).items.find(item=>item.reservationId===reservations[job].id);
    check(guest.executions[0].id===staff.executions[0].id&&guest.feedback.id===staff.feedback.id&&staff.feedback.revision===1,'服务ID及反馈版本双方一致 '+job);
    const replay=await call(job,`/staff/schedule/${reservations[job].id}/execution`,'POST',{status:'completed',note:job+'阶段2合成服务完成'});
    check(replay.replayed===true,'重复服务记录幂等 '+job);
  }
  await login('coach'); const absent=page.locator(`[data-reservation-id="${reservations.noShow.id}"]`);await absent.waitFor();
  await absent.getByLabel('服务工作说明').fill('合成客人未参加，保留容量');await absent.getByRole('button',{name:'登记未参加',exact:true}).click();
  await absent.getByText(/已登记未参加/).waitFor();
  await call('guest',`/me/reservations/${reservations.noShow.id}/checkin`,'POST',{},409);
  check((await call('guest','/reservations')).items.find(row=>row.id===reservations.noShow.id).status==='no_show','客人预约回读未参加');
  await login('dietitian');await page.getByRole('heading',{name:'备餐订单',exact:true}).waitFor();
  await page.getByRole('button',{name:'开始备餐',exact:true}).click();await page.getByRole('button',{name:'标记已送达',exact:true}).waitFor();
  await page.getByRole('button',{name:'标记已送达',exact:true}).click();await page.getByText('已送达',{exact:true}).waitFor();await snap('04-dietitian-delivered');
  check((await call('guest',`/meals/orders?date=${cfg.date}`))[0].id===orderId&& (await call('guest',`/meals/orders?date=${cfg.date}`))[0].status==='delivered','客人同订单回读送达');
  await login('dean');await page.locator('.side-nav').getByRole('button',{name:'院长意见',exact:true}).click();
  const logs={};for(const job of ['coach','therapist','dietitian','clinician','administrator']){
    logs[job]=await call('dean',`/dean/staff/${staffIds[job]}/logs`);
    check(logs[job].logs.some(row=>row.action===({coach:'service.execution.record',therapist:'service.execution.record',dietitian:'meal.order.status',clinician:'health_intake.confirm',administrator:'assignment.create'})[job]),'院长读取实际业务记录 '+job);
  }
  const summary=await call('dean',`/admin/operations/summary?date=${cfg.date}`);check(summary.metrics.find(row=>row.key==='reservations').value===3,'院长运营计数同库三预约');
  await page.getByRole('button',{name:/演示教练/}).first().click();await page.getByText('记录服务执行',{exact:true}).first().waitFor();await snap('05-dean-work-records');
  await login('guest');await page.locator('.side-nav').getByRole('button',{name:'日程',exact:true}).click();
  await page.locator(`[data-testid="q24-appointment-${reservations.coach.id}"]`).getByText(/服务已完成/).waitFor();
  await snap('06-guest-service-readback',`[data-testid="q24-appointment-${reservations.coach.id}"]`);
  evidence.objects.finalGuest=await call('guest','/me/checkins'); evidence.objects.finalOrders=await call('guest',`/meals/orders?date=${cfg.date}`);
  evidence.objects.logs=Object.fromEntries(Object.entries(logs).map(([job,value])=>[job,value.logs.filter(row=>['service.execution.record','meal.order.status','health_intake.confirm','assignment.create'].includes(row.action))]));
  check(evidence.pageErrors.length===0,'网页错误0');check(evidence.externalRequests.length===0,'浏览器外网0');
}
