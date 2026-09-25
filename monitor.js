/**
 * 쿠팡 중국 판매자 모니터링 v1
 * ================================
 * 매일/매주 실행하여 새로운 중국 판매자를 탐지
 * 
 * 실행: eval(await fs.readFile('.../monitor.js','utf-8')); await monitor(page);
 * 
 * 동작:
 *   1. products.json 품목 순회
 *   2. 각 품목 검색 → 배송 10일+ 상품 방문
 *   3. "다른 판매자 보기" → 전체 판매자 추출
 *   4. 캐시에 없는 판매자 = 새 판매자 → 대표자 확인
 *   5. 중국인이면 알림 + 캐시 저장
 *   6. 기존 중국 판매자가 사라졌으면 "정지 추정" 기록
 * 
 * 봇차단 방지:
 *   - fetch() 절대 안 씀
 *   - 15~25초 랜덤 대기
 *   - 차단 즉시 중단
 */

const PROJECT = 'C:\\Users\\luna2\\.aside\\u\\0\\projects\\coupang-china-seller-finder';

async function loadCache() { try{return JSON.parse(await fs.readFile(`${PROJECT}\\seller_cache.json`,'utf-8'))}catch(e){return{}} }
async function saveCache(c) { await fs.writeFile(`${PROJECT}\\seller_cache.json`,JSON.stringify(c,null,2),'utf-8') }
async function loadProducts() { return JSON.parse(await fs.readFile(`${PROJECT}\\products.json`,'utf-8')) }
function rDelay() { return 15000 + Math.floor(Math.random()*10000) }
async function cleanTabs() { while(tabs.length>1){try{await closeTab(tabs[tabs.length-1])}catch(e){}} }

// 한국 성씨 목록
const KR_SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남노하곽성차주우구민나진지엄채원천방공현도';
const KR_ENG = /^(KIM|LEE|PARK|CHOI|JUNG|KANG|CHO|YOON|JANG|LIM|HAN|OH|SEO|SHIN|KWON|HWANG|AHN|SONG|RYU|JEON|HONG)/i;

function judgeRep(rep) {
  if (!rep || rep === '미확인') return 'unknown';
  // 한자 = 중국
  if (/[\u4e00-\u9fff]/.test(rep)) return 'chinese';
  // 영문 = 한국 영문성씨 아니면 중국
  if (/^[A-Z]/i.test(rep)) return KR_ENG.test(rep) ? 'korean' : 'chinese';
  // 한글: 3글자 + 한국 성씨 = 한국, 그 외 = 중국
  if (/^[가-힣]{2,4}$/.test(rep)) return KR_SURNAMES.includes(rep[0]) ? 'korean' : 'chinese';
  return 'unknown';
}

async function monitor(pg) {
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  중국 판매자 모니터링 - ${ts}`);
  console.log(`${'═'.repeat(50)}\n`);

  const {brands, categories} = await loadProducts();
  const cache = await loadCache();
  const newSellers = [];
  const goneSellers = []; // 사라진 판매자
  let blocked = false;

  // 전체 조합 대신 핵심 조합만 (효율화)
  const combos = [];
  for (const brand of brands) {
    for (const cat of categories) {
      combos.push({ brand, cat, query: `${brand} ${cat}` });
    }
  }
  // 셔플해서 매번 다른 순서로 검색 (패턴 방지)
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }

  for (const combo of combos) {
    if (blocked) break;

    console.log(`[${combo.query}]`);
    await sleep(rDelay());
    
    // 검색
    await pg.goto('https://www.coupang.com/np/search?q=' + encodeURIComponent(combo.query));
    await sleep(6000);

    // 배송 10일+ 상품 URL (배송 긴 순)
    const url = await pg.evaluate(() => {
      const today = new Date(); today.setHours(0,0,0,0);
      const items = [];
      for (const el of document.querySelectorAll('li.ProductUnit_productUnit__Qd6sv')) {
        const srcs = Array.from(el.querySelectorAll('img')).map(im=>im.src||'');
        if (srcs.some(s=>s.includes('rocket')||s.includes('global'))) continue;
        const txt = el.textContent;
        if (txt.includes('내일')&&txt.includes('도착')) continue;
        const dm = txt.match(/(\d+)\/(\d+)/);
        if (!dm) continue;
        const d = new Date(today.getFullYear(),parseInt(dm[1])-1,parseInt(dm[2]));
        if (d<today) d.setFullYear(d.getFullYear()+1);
        const days = Math.round((d-today)/86400000);
        if (days >= 10) {
          const a = el.querySelector('a[href*="/vp/"]');
          if (a) items.push({ days, href: a.href });
        }
      }
      items.sort((a,b) => b.days - a.days);
      return items[0]?.href || null;
    });

    if (!url) { console.log('  → 10일+ 없음'); continue; }

    // 상품 페이지 방문
    await sleep(rDelay());
    await pg.goto(url, { waitUntil:'domcontentloaded', timeout:15000 });
    await sleep(5000);
    await cleanTabs();

    // 차단/해외배송 체크
    const pageCheck = await pg.evaluate(() => {
      const t = document.body.innerText;
      return {
        blocked: t.includes('사용권한'),
        overseas: t.includes('개인통관고유부호') || t.includes('해외 배송 상품'),
      };
    });
    if (pageCheck.blocked) { console.log('  ⚠ 차단! 중단.'); blocked=true; break; }
    if (pageCheck.overseas) { console.log('  → 해외배송 스킵'); continue; }

    // "다른 판매자 보기" 클릭
    const sn = await snapshot(pg, {interactive:true});
    const btn = sn.tree.match(/ref=(e\d+).*다른 판매자/);
    if (btn) { await pg.locator(btn[1]).click(); await sleep(3000); }

    // 전체 판매자 추출
    const known = Object.keys(cache);
    const sellers = await pg.evaluate((known) => {
      const pid = location.href.match(/products\/(\d+)/)?.[1];
      const rows = document.querySelectorAll('tr[data-row-key]');
      return Array.from(rows).map(r => {
        const txt = r.textContent;
        const prM = txt.match(/(\d{1,3}(,\d{3})+)원/);
        const dvM = txt.match(/((\d+)\/(\d+).*?도착\s*예정|내일.*?도착)/);
        const selM = txt.match(/도착\s*(?:예정)?\s*([가-힣a-zA-Z\s(),.]{2,60})/);
        let seller = selM?.[1]?.trim().replace(/\d+%.*$/,'').replace(/건 이하.*$/,'').trim();
        return {
          vid: r.getAttribute('data-row-key'),
          seller, price: prM?.[0], delivery: dvM?.[0],
          isNew: seller && !known.includes(seller),
          pid,
        };
      }).filter(s => s.price);
    }, known);

    // 새 판매자 확인
    const newOnes = sellers.filter(s => s.isNew);
    if (newOnes.length === 0) { console.log('  → 새 판매자 없음'); continue; }

    console.log(`  → 새 판매자 ${newOnes.length}명 발견!`);

    // 대표자 확인을 위해 각 새 판매자의 vendorItemId로 접속
    for (const s of newOnes) {
      if (blocked) break;
      await sleep(rDelay());
      await pg.goto(`https://www.coupang.com/vp/products/${s.pid}?vendorItemId=${s.vid}`, {
        waitUntil:'domcontentloaded', timeout:15000
      });
      await sleep(5000);
      await cleanTabs();

      const info = await pg.evaluate(() => {
        const t = document.body.innerText;
        if (t.includes('사용권한')) return { blocked:true };
        const overseas = t.includes('개인통관고유부호') || t.includes('해외 배송 상품');
        const rm = t.match(/상호\/?대표자\s*([^\n]{2,100})/);
        let rep = null;
        if (rm) { const p = rm[1].split('/').map(s=>s.trim()); rep = p.length>=2 ? p[p.length-1] : null; }
        return { rep, overseas };
      });

      if (info.blocked) { console.log('  ⚠ 차단!'); blocked=true; break; }
      if (info.overseas) {
        cache[s.seller] = { rep: info.rep||'미확인', isChinese:false, reason:'해외배송' };
        console.log(`  ✗ ${s.seller} / ${info.rep} → 해외배송`);
        continue;
      }

      const judge = judgeRep(info.rep);
      cache[s.seller] = {
        rep: info.rep || '미확인',
        isChinese: judge === 'chinese',
        reason: judge === 'chinese' ? `대표자(${info.rep})` : `한국인(${info.rep})`,
      };

      if (judge === 'chinese') {
        console.log(`  ★🇨🇳 새 중국 판매자! ${s.seller} / ${info.rep} | ${s.price} | ${s.delivery}`);
        console.log(`     → https://www.coupang.com/vp/products/${s.pid}?vendorItemId=${s.vid}`);
        newSellers.push({
          brand: combo.brand, cat: combo.cat,
          seller: s.seller, rep: info.rep,
          price: s.price, delivery: s.delivery,
          link: `https://www.coupang.com/vp/products/${s.pid}?vendorItemId=${s.vid}`,
        });
      } else {
        console.log(`  ✗ ${s.seller} / ${info.rep} → 한국인`);
      }
    }

    // 주기적 캐시 저장
    await saveCache(cache);
  }

  // ─── 결과 출력 ───
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  모니터링 결과`);
  console.log(`${'═'.repeat(50)}\n`);

  if (newSellers.length) {
    console.log(`🇨🇳 새 중국 판매자 ${newSellers.length}명 발견!\n`);
    newSellers.forEach(s => {
      console.log(`  ${s.brand} ${s.cat} | ${s.seller} / ${s.rep} | ${s.price} | ${s.delivery}`);
      console.log(`  → ${s.link}`);
    });
  } else {
    console.log('새 중국 판매자 없음');
  }

  // 결과 저장
  const report = {
    runAt: new Date().toISOString(),
    newSellers,
    totalCached: Object.keys(cache).length,
    totalChinese: Object.entries(cache).filter(([,v])=>v.isChinese===true).length,
  };
  await fs.writeFile(`${PROJECT}\\results\\monitor-${ts}.json`, JSON.stringify(report,null,2), 'utf-8');
  console.log(`\n결과: results/monitor-${ts}.json`);
  console.log(`캐시: ${report.totalCached}명 (중국: ${report.totalChinese})`);

  return report;
}
