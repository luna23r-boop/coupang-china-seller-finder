/**
 * 쿠팡 중국 판매자 찾기 v2
 * =========================
 * 실행: eval(await fs.readFile('.../index.js','utf-8')); await main(page);
 *
 * 변경사항 (v2):
 *   - 여러 페이지 넘기며 검색 (1~3페이지)
 *   - 배송일 긴 상품 우선 (16일+ > 10일+ > 6일+)
 *   - 의류 사이즈 지원 (S/M/L/XL)
 *   - products.json에 브랜드+키워드만 설정하면 자동 검색
 */

const PROJECT = 'C:\\Users\\luna2\\.aside\\u\\0\\projects\\coupang-china-seller-finder';

// ─── 유틸 ───
async function loadCache() {
  try { return JSON.parse(await fs.readFile(`${PROJECT}\\seller_cache.json`, 'utf-8')); }
  catch(e) { return {}; }
}
async function saveCache(c) { await fs.writeFile(`${PROJECT}\\seller_cache.json`, JSON.stringify(c,null,2), 'utf-8'); }
async function loadProducts() { return JSON.parse(await fs.readFile(`${PROJECT}\\products.json`, 'utf-8')); }
function rDelay() { return 15000 + Math.floor(Math.random() * 10000); }
async function cleanTabs() { while(tabs.length>1){try{await closeTab(tabs[tabs.length-1])}catch(e){}} }

function isChinese(seller, rep) {
  if (seller) {
    if (/[\u4e00-\u9fff]/.test(seller)) return '판매자명 중국어';
    if (/유한회사/.test(seller)) return '유한회사(중국법인)';
    if (/트레이딩|무역|trading/i.test(seller)) return '트레이딩/무역';
    if (/Co\.?,?\s*Ltd/i.test(seller) && !/주식회사/.test(seller)) return '중국식 영문상호';
  }
  if (rep) {
    if (/[\u4e00-\u9fff]/.test(rep)) return '대표자 중국어';
    if (/^(왕|리|류|장|진|마|후|쿠|치|동|딩|방|우|펀|파|런|궈|루|란|웨|러|쉬|탕|셴)/.test(rep))
      return `대표자 중국식(${rep})`;
    if (/^(LUO|WANG|LI|ZHANG|CHEN|LIU|YANG|HUANG|ZHAO|WU|ZHOU|XU|SUN|MA|HU|GUO|LIN|HE|LU|TANG|DENG|FENG|XIAO|CHENG|PAN|YUAN|JIANG)/i.test(rep))
      return `대표자 핑인(${rep})`;
  }
  return null;
}

// ─── 검색 결과에서 배송 5일 초과 + 일반 마켓 상품 후보 추출 ───
// 배송일 긴 순서로 정렬해서 반환
async function scanPage(pg) {
  return pg.evaluate(() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const items = [];
    for (const el of document.querySelectorAll('li.ProductUnit_productUnit__Qd6sv')) {
      const srcs = Array.from(el.querySelectorAll('img')).map(im=>im.src||'');
      if (srcs.some(s=>s.includes('rocket')||s.includes('global'))) continue;
      const txt = el.textContent;
      const dm = txt.match(/(\d+)\/(\d+)/);
      if (!dm) continue;
      const d = new Date(today.getFullYear(), parseInt(dm[1])-1, parseInt(dm[2]));
      if (d < today) d.setFullYear(d.getFullYear()+1);
      const days = Math.round((d - today) / 86400000);
      if (days <= 5) continue;
      const a = el.querySelector('a[href*="/vp/"]');
      const name = el.querySelector('img')?.alt?.substring(0,60);
      items.push({ name, days, href: a?.href });
    }
    // 배송일 긴 순서 (중국 판매자 가능성 높은 순)
    return items.sort((a,b) => b.days - a.days);
  });
}

// ─── 다음 페이지 이동 ───
async function goNextPage(pg) {
  return pg.evaluate(() => {
    // 페이지네이션에서 다음 버튼 찾기
    const nextBtns = document.querySelectorAll('button[class*="next"], a[class*="next"]');
    for (const b of nextBtns) {
      if (!b.disabled) { b.click(); return true; }
    }
    // 숫자 페이지 버튼 중 현재 다음 번호
    const active = document.querySelector('[class*="active"] [class*="page"], [aria-current="page"]');
    if (active) {
      const cur = parseInt(active.textContent);
      const allPages = document.querySelectorAll('a[class*="page"], button[class*="page"]');
      for (const p of allPages) {
        if (parseInt(p.textContent) === cur + 1) { p.click(); return true; }
      }
    }
    return false;
  });
}

// ─── 검색 (여러 페이지 스캔) → 배송 긴 상품 우선 반환 ───
async function findCandidates(pg, query, maxPages) {
  await pg.goto('https://www.coupang.com');
  await sleep(rDelay());
  await pg.locator('[placeholder*="검색"]').fill(query);
  await sleep(2000);
  await pg.keyboard.press('Enter');
  await sleep(8000);

  let allCandidates = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    console.log(`    페이지 ${pageNum} 스캔...`);
    const items = await scanPage(pg);
    console.log(`    → ${items.length}개 후보 (최대 배송 ${items[0]?.days || 0}일)`);
    allCandidates.push(...items);

    // 배송 14일+ 상품이 있으면 충분, 더 넘길 필요 없음
    if (items.some(i => i.days >= 14)) break;

    // 다음 페이지
    if (pageNum < maxPages) {
      const moved = await goNextPage(pg);
      if (!moved) { console.log('    → 마지막 페이지'); break; }
      await sleep(5000);
    }
  }

  // 중복 제거 + 배송일 긴 순 정렬
  const seen = new Set();
  return allCandidates
    .filter(c => { if (!c.href || seen.has(c.href)) return false; seen.add(c.href); return true; })
    .sort((a,b) => b.days - a.days);
}

// ─── 상품 페이지에서 판매자 추출 ───
async function extractSellers(pg) {
  await cleanTabs();
  const blocked = await pg.evaluate(() => document.body.innerText.includes('사용권한'));
  if (blocked) return { error: 'blocked' };

  const baseInfo = await pg.evaluate(() => {
    const t = document.body.innerText;
    const pid = location.href.match(/products\/(\d+)/)?.[1];
    const title = document.querySelector('h1')?.textContent?.trim() || '';
    // 사이즈: 숫자(신발) + 문자(의류)
    const sizes = [];
    document.querySelectorAll('li').forEach(li => {
      const v = li.textContent.trim();
      if (/^(\d{3}|S|M|L|XL|2XL|3XL|XXL|FREE)$/i.test(v)) sizes.push(v);
    });
    const sm = (t.match(/판매자:\s*([^\n]{2,80})/)||[])[1]?.trim()
      .replace(/판매자\s*평가.*/,'').replace(/\s*다른 판매자.*/,'').trim();
    const rm = t.match(/상호\/?대표자\s*([^\n]{2,100})/);
    let rep = null, company = null;
    if (rm) { const p = rm[1].split('/').map(s=>s.trim()); company=p[0]; rep=p.length>=2?p[p.length-1]:null; }
    return { pid, title, sizes: [...new Set(sizes)], seller: sm, company, rep };
  });

  // "다른 판매자 보기" 클릭
  const sn = await snapshot(pg, { interactive: true });
  const btnMatch = sn.tree.match(/ref=(e\d+).*다른 판매자/);
  if (btnMatch) {
    await pg.locator(btnMatch[1]).click();
    await sleep(3000);
  }

  // vendorItemId + 판매자명 추출
  const sellers = await pg.evaluate(() => {
    const rows = document.querySelectorAll('tr[data-row-key]');
    return Array.from(rows).map(r => {
      const t = r.textContent;
      const prM = t.match(/(\d{1,3}(,\d{3})+)원/);
      const price = prM ? parseInt(prM[1].replace(/,/g,'')) : 0;
      const dvM = t.match(/((\d+)\/(\d+)\s*(\(.*?\))?\s*도착\s*예정|내일.*?도착)/);
      const selM = t.match(/도착\s*(?:예정)?\s*([가-힣a-zA-Z\s()]{2,40})/);
      let seller = selM?.[1]?.trim().replace(/\d+%.*$/,'').replace(/건 이하.*$/,'').trim();
      return { vid: r.getAttribute('data-row-key'), seller, price, priceText: prM?.[0]||'', delivery: dvM?.[0]||'' };
    }).filter(r => r.price > 0);
  });

  return { ...baseInfo, sellers };
}

// ═══════════════════════════════════
//  메인
// ═══════════════════════════════════
async function main(pg) {
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  쿠팡 중국 판매자 찾기 v2 - ${ts}`);
  console.log(`${'═'.repeat(50)}\n`);

  const products = await loadProducts();
  const cache = await loadCache();
  const allResults = [];
  const MAX_PAGES = 3; // 최대 3페이지까지 스캔

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    console.log(`\n[${i+1}/${products.length}] ${p.brand} ${p.item}`);
    console.log('─'.repeat(40));

    // 1) 검색 + 여러 페이지 스캔 → 배송 긴 순 후보
    const candidates = await findCandidates(pg, p.query, MAX_PAGES);
    if (!candidates.length) {
      console.log('  → 조건 맞는 상품 없음');
      allResults.push({ brand:p.brand, item:p.item, status:'no_product', chineseSellers:[] });
      continue;
    }
    console.log(`  후보 ${candidates.length}개 (최장 배송 ${candidates[0].days}일)`);

    // 2) 배송 긴 상품부터 순서대로 시도 (최대 2개까지만 방문)
    let found = false;
    for (let ci = 0; ci < Math.min(candidates.length, 2); ci++) {
      const cand = candidates[ci];
      console.log(`  시도 ${ci+1}: ${cand.name} (${cand.days}일)`);

      await sleep(rDelay());
      await pg.goto(cand.href, { waitUntil:'domcontentloaded', timeout:15000 });
      await sleep(5000);
      await cleanTabs();

      // 3) 판매자 추출
      const data = await extractSellers(pg);
      if (data.error === 'blocked') {
        console.log('  ⚠ 차단! 즉시 중단.');
        await saveCache(cache);
        return allResults;
      }

      console.log(`  상품: ${data.title?.substring(0,40)}`);
      console.log(`  판매자: ${data.seller} / 대표: ${data.rep}`);
      console.log(`  사이즈: ${data.sizes?.join(', ') || '페이지 확인'}`);
      console.log(`  다른 판매자: ${data.sellers?.length || 0}명`);

      // 4) 최저가 50% 필터
      const lowest = Math.min(...data.sellers.map(s=>s.price).filter(p=>p>0));
      const maxP = lowest * 1.5;

      // 5) 판매자 판별
      const validSellers = [];
      for (const s of (data.sellers||[])) {
        if (s.price > maxP) continue;

        // 캐시
        if (cache[s.seller]) {
          const cc = cache[s.seller];
          if (cc.isChinese === false) continue;
          if (cc.isChinese === true) {
            validSellers.push({
              seller:s.seller, rep:cc.rep, reason:cc.reason,
              price:s.price, priceText:s.priceText, delivery:s.delivery, vid:s.vid,
              link:`https://www.coupang.com/vp/products/${data.pid}?vendorItemId=${s.vid}`,
            });
            continue;
          }
        }

        // 이름 판별
        const reason = isChinese(s.seller, data.rep);
        if (reason) {
          cache[s.seller] = { rep:data.rep||'미확인', isChinese:true, reason };
          validSellers.push({
            seller:s.seller, rep:data.rep, reason,
            price:s.price, priceText:s.priceText, delivery:s.delivery, vid:s.vid,
            link:`https://www.coupang.com/vp/products/${data.pid}?vendorItemId=${s.vid}`,
          });
        } else {
          cache[s.seller] = { rep:'미확인', isChinese:'unknown', reason:'미확인' };
        }
      }

      if (validSellers.length) {
        console.log(`  🇨🇳 중국 판매자 ${validSellers.length}명 발견!`);
        validSellers.forEach(s => console.log(`     ${s.seller} | ${s.priceText} | ${s.delivery}`));
        allResults.push({
          brand:p.brand, item:p.item, pid:data.pid, title:data.title,
          sizes:data.sizes, status:'found', chineseSellers:validSellers,
        });
        found = true;
        break; // 찾았으면 다음 품목으로
      }
    }

    if (!found) {
      console.log('  → 중국 판매자 없음');
      allResults.push({ brand:p.brand, item:p.item, status:'no_chinese', chineseSellers:[] });
    }
  }

  await saveCache(cache);

  // ─── 결과 출력 ───
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  최종 결과');
  console.log(`${'═'.repeat(50)}\n`);

  allResults.filter(r=>r.status==='found').forEach(r => {
    console.log(`🇨🇳 ${r.brand} ${r.item} (사이즈: ${r.sizes?.join(',') || '?'})`);
    r.chineseSellers.forEach(s => {
      console.log(`   ${s.seller} | ${s.priceText} | ${s.delivery}`);
      console.log(`   → ${s.link}`);
    });
    console.log('');
  });
  allResults.filter(r=>r.status!=='found').forEach(r => {
    console.log(`❌ ${r.brand} ${r.item}: ${r.status==='no_product'?'적합 상품 없음':'중국 판매자 없음'}`);
  });

  // 교차 분석
  const sMap = {};
  allResults.filter(r=>r.status==='found').forEach(r => {
    r.chineseSellers.forEach(s => {
      if (!sMap[s.seller]) sMap[s.seller] = [];
      sMap[s.seller].push({ brand:r.brand, item:r.item, price:s.priceText, link:s.link });
    });
  });
  const multi = Object.entries(sMap).filter(([,i])=>i.length>=2);
  if (multi.length) {
    console.log('\n같은 판매자 + 다른 품목:');
    multi.forEach(([s,items]) => {
      console.log(`  ✅ ${s} (${items.length}개)`);
      items.forEach(it => console.log(`     ${it.brand} ${it.item} | ${it.price}`));
    });
  }

  // 저장
  const report = { runAt:new Date().toISOString(), results:allResults, crossSellers:multi.map(([s,i])=>({seller:s,items:i})) };
  await fs.writeFile(`${PROJECT}\\results\\${ts}.json`, JSON.stringify(report,null,2), 'utf-8');
  console.log(`\n결과 저장: results/${ts}.json`);
  return report;
}
