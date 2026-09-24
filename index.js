/**
 * 쿠팡 중국 판매자 찾기 (Aside REPL용)
 * ======================================
 * 실행: eval(await fs.readFile('.../index.js','utf-8')); await main(page);
 *
 * 기능:
 *   1. products.json의 인기 품목을 하나씩 쿠팡에서 검색
 *   2. 배송 5일 초과 + 일반 마켓플레이스 상품만 선별
 *   3. "다른 판매자 보기"에서 전체 판매자 추출
 *   4. seller_cache.json으로 이미 확인한 판매자는 스킵
 *   5. 상호/대표자명으로 중국인 판별
 *   6. 최저가 50% 이내만 포함
 *   7. 판매자별 vendorItemId로 직접 구매 링크 생성
 *   8. 결과를 results/ 에 JSON 저장
 *
 * 봇차단 방지:
 *   - fetch() 절대 안 씀
 *   - 한번에 탭 1개만
 *   - 페이지 이동 사이 15~25초 랜덤 대기
 *   - 차단 감지 시 즉시 중단
 */

const PROJECT = 'C:\\Users\\luna2\\.aside\\u\\0\\projects\\coupang-china-seller-finder';

// ─── 판매자 캐시 ───
async function loadCache() {
  try { return JSON.parse(await fs.readFile(`${PROJECT}\\seller_cache.json`, 'utf-8')); }
  catch(e) { return {}; }
}
async function saveCache(cache) {
  await fs.writeFile(`${PROJECT}\\seller_cache.json`, JSON.stringify(cache, null, 2), 'utf-8');
}

// ─── 품목 리스트 ───
async function loadProducts() {
  return JSON.parse(await fs.readFile(`${PROJECT}\\products.json`, 'utf-8'));
}

// ─── 중국인 판별 ───
function isChinese(seller, rep) {
  if (seller) {
    if (/[\u4e00-\u9fff]/.test(seller)) return '판매자명 중국어';
    if (/유한회사/.test(seller)) return '유한회사(중국법인)';
    if (/트레이딩|무역|trading/i.test(seller)) return '트레이딩/무역';
    if (/Co\.?,?\s*Ltd/i.test(seller) && !/주식회사/.test(seller)) return '중국식 영문상호';
  }
  if (rep) {
    if (/[\u4e00-\u9fff]/.test(rep)) return '대표자 중국어';
    if (/^(왕|리|류|장|진|마|후|쿠|치|동|딩|방|우|펀|파|런|궈|루|란|웨|러|쉬|탕|셴)/.test(rep)) return `대표자 중국식(${rep})`;
    if (/^(LUO|WANG|LI|ZHANG|CHEN|LIU|YANG|HUANG|ZHAO|WU|ZHOU|XU|SUN|MA|HU|GUO|LIN|HE|LU|TANG|DENG|FENG|XIAO|CHENG|PAN|YUAN|JIANG)/i.test(rep)) return `대표자 핑인(${rep})`;
  }
  return null;
}

// ─── 랜덤 대기 (15~25초) ───
function randomDelay() {
  return 15000 + Math.floor(Math.random() * 10000);
}

// ─── 팝업 정리 ───
async function cleanPopups() {
  while (tabs.length > 1) { try { await closeTab(tabs[tabs.length - 1]); } catch(e) {} }
}

// ─── 검색 결과에서 적합한 상품 URL 1개 추출 (DOM만, 네트워크 없음) ───
async function findProductUrl(pg, query) {
  await pg.goto('https://www.coupang.com');
  await sleep(randomDelay());
  await pg.locator('[placeholder*="검색"]').fill(query);
  await sleep(2000);
  await pg.keyboard.press('Enter');
  await sleep(8000);

  return pg.evaluate(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const el of document.querySelectorAll('li.ProductUnit_productUnit__Qd6sv')) {
      // 로켓직구/그로스 제외
      const srcs = Array.from(el.querySelectorAll('img')).map(im => im.src || '');
      if (srcs.some(s => s.includes('rocket') || s.includes('global'))) continue;
      // 배송 5일 이내 제외
      const dm = el.textContent.match(/(\d+)\/(\d+)/);
      if (!dm) continue;
      const d = new Date(today.getFullYear(), parseInt(dm[1]) - 1, parseInt(dm[2]));
      if (d < today) d.setFullYear(d.getFullYear() + 1);
      const days = Math.round((d - today) / 86400000);
      if (days <= 5) continue;
      const a = el.querySelector('a[href*="/vp/"]');
      if (a) return a.href;
    }
    return null;
  });
}

// ─── 상품 페이지에서 "다른 판매자 보기" 열고 전체 판매자 + vendorItemId 추출 ───
async function extractSellers(pg) {
  await cleanPopups();

  // 차단 확인
  const blocked = await pg.evaluate(() => document.body.innerText.includes('사용권한'));
  if (blocked) return { error: 'blocked' };

  // 기본 정보
  const baseInfo = await pg.evaluate(() => {
    const t = document.body.innerText;
    const pid = location.href.match(/products\/(\d+)/)?.[1];
    const title = document.querySelector('h1')?.textContent?.trim() || '';
    const sizes = [];
    document.querySelectorAll('li').forEach(li => {
      if (/^\d{3}$/.test(li.textContent.trim())) sizes.push(li.textContent.trim());
    });
    // 현재 판매자 대표자
    const rm = t.match(/상호\/?대표자\s*([^\n]{2,100})/);
    let rep = null, company = null;
    if (rm) { const p = rm[1].split('/').map(s => s.trim()); company = p[0]; rep = p.length >= 2 ? p[p.length - 1] : null; }
    return { pid, title, sizes: [...new Set(sizes)].sort(), rep, company };
  });

  // "다른 판매자 보기" 클릭
  const sn = await snapshot(pg, { interactive: true });
  const btnMatch = sn.tree.match(/ref=(e\d+).*다른 판매자/);
  if (btnMatch) {
    await pg.locator(btnMatch[1]).click();
    await sleep(3000);
  }

  // 판매자 목록 + vendorItemId 추출
  const sellers = await pg.evaluate(() => {
    const rows = document.querySelectorAll('tr[data-row-key]');
    return Array.from(rows).map(r => ({
      vid: r.getAttribute('data-row-key'),
      text: r.textContent,
    })).filter(r => r.text.includes('원')).map(r => {
      const t = r.text;
      const priceMatch = t.match(/(\d{1,3}(,\d{3})+)원/);
      const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;
      const delivMatch = t.match(/((\d+)\/(\d+)\s*(\(.*?\))?\s*도착\s*예정|내일.*?도착)/);
      // 판매자명: 가격/배송 뒤에 오는 한글 이름
      const sellerMatch = t.match(/도착\s*(?:예정)?\s*([가-힣a-zA-Z\s()]{2,40})/);
      let seller = sellerMatch ? sellerMatch[1].trim() : null;
      if (seller) seller = seller.replace(/\d+%.*$/, '').replace(/건 이하.*$/, '').trim();
      return {
        vid: r.vid,
        seller,
        price,
        priceText: priceMatch?.[0] || '',
        delivery: delivMatch?.[0] || '',
      };
    });
  });

  return { ...baseInfo, sellers };
}

// ═══════════════════════════════════
//  메인 실행
// ═══════════════════════════════════
async function main(pg) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  쿠팡 중국 판매자 찾기 - ${ts}`);
  console.log(`${'═'.repeat(50)}\n`);

  const products = await loadProducts();
  const cache = await loadCache();
  const allResults = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    console.log(`\n[${i + 1}/${products.length}] ${p.brand} ${p.item}`);
    console.log('─'.repeat(40));

    // 1) 검색 → 상품 URL 추출
    const url = await findProductUrl(pg, p.query);
    if (!url) {
      console.log('  → 조건 맞는 상품 없음 (배송 5일 초과 일반 마켓)');
      allResults.push({ brand: p.brand, item: p.item, status: 'no_product', sellers: [] });
      continue;
    }

    // 2) 상품 페이지 이동
    await sleep(randomDelay());
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(5000);
    await cleanPopups();

    // 3) 판매자 추출
    const data = await extractSellers(pg);
    if (data.error === 'blocked') {
      console.log('  ⚠ 차단 감지! 즉시 중단.');
      break;
    }

    console.log(`  상품: ${data.title?.substring(0, 40)}`);
    console.log(`  사이즈: ${data.sizes?.join(', ') || '페이지 확인'}`);
    console.log(`  판매자 ${data.sellers?.length || 0}명`);

    // 4) 최저가 기준 50% 필터
    const lowestPrice = Math.min(...data.sellers.map(s => s.price).filter(p => p > 0));
    const maxPrice = lowestPrice * 1.5;

    // 5) 각 판매자 판별
    const validSellers = [];
    for (const s of (data.sellers || [])) {
      if (s.price > maxPrice) {
        console.log(`  ✗ ${s.seller} ${s.priceText} → 50% 초과 제외`);
        continue;
      }

      // 캐시 확인
      if (cache[s.seller]) {
        const cached = cache[s.seller];
        if (cached.isChinese === false) {
          console.log(`  ✗ ${s.seller} → 캐시: 한국인 (${cached.rep})`);
          continue;
        }
        if (cached.isChinese === true) {
          console.log(`  ✓ ${s.seller} ${s.priceText} → 캐시: 중국인 (${cached.reason})`);
          validSellers.push({
            seller: s.seller, rep: cached.rep, reason: cached.reason,
            price: s.price, priceText: s.priceText, delivery: s.delivery,
            vid: s.vid,
            link: `https://www.coupang.com/vp/products/${data.pid}?vendorItemId=${s.vid}`,
          });
          continue;
        }
      }

      // 캐시에 없거나 unknown → 이름으로 1차 판별
      const reason = isChinese(s.seller, data.rep);
      if (reason) {
        console.log(`  ✓ ${s.seller} ${s.priceText} → ${reason}`);
        cache[s.seller] = { rep: data.rep || '미확인', isChinese: true, reason };
        validSellers.push({
          seller: s.seller, rep: data.rep, reason,
          price: s.price, priceText: s.priceText, delivery: s.delivery,
          vid: s.vid,
          link: `https://www.coupang.com/vp/products/${data.pid}?vendorItemId=${s.vid}`,
        });
      } else {
        console.log(`  ? ${s.seller} ${s.priceText} → 판별 불가 (대표자 확인 필요)`);
        cache[s.seller] = { rep: '미확인', isChinese: 'unknown', reason: '미확인' };
      }
    }

    allResults.push({
      brand: p.brand, item: p.item, pid: data.pid,
      title: data.title, sizes: data.sizes,
      status: validSellers.length ? 'found' : 'no_chinese',
      chineseSellers: validSellers,
    });
  }

  // 캐시 저장
  await saveCache(cache);

  // ─── 최종 결과 출력 ───
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  최종 결과');
  console.log(`${'═'.repeat(50)}\n`);

  const found = allResults.filter(r => r.status === 'found');
  const none = allResults.filter(r => r.status !== 'found');

  found.forEach(r => {
    console.log(`🇨🇳 ${r.brand} ${r.item} (사이즈: ${r.sizes?.join(',') || '?'})`);
    r.chineseSellers.forEach(s => {
      console.log(`   ${s.seller} | ${s.priceText} | ${s.delivery}`);
      console.log(`   → ${s.link}`);
    });
    console.log('');
  });

  none.forEach(r => {
    console.log(`❌ ${r.brand} ${r.item}: ${r.status === 'no_product' ? '적합 상품 없음' : '중국 판매자 없음'}`);
  });

  // 교차 분석: 같은 판매자가 여러 품목에 등장
  const sellerMap = {};
  found.forEach(r => {
    r.chineseSellers.forEach(s => {
      if (!sellerMap[s.seller]) sellerMap[s.seller] = [];
      sellerMap[s.seller].push({ brand: r.brand, item: r.item, price: s.priceText, link: s.link });
    });
  });

  const multiSellers = Object.entries(sellerMap).filter(([, items]) => items.length >= 2);
  if (multiSellers.length) {
    console.log(`\n${'─'.repeat(40)}`);
    console.log('같은 판매자 + 서로 다른 품목:');
    multiSellers.forEach(([seller, items]) => {
      console.log(`\n  ✅ ${seller} (${items.length}개 품목)`);
      items.forEach(it => console.log(`     ${it.brand} ${it.item} | ${it.price} | ${it.link}`));
    });
  }

  // 결과 파일 저장
  const report = { runAt: new Date().toISOString(), results: allResults, crossSellers: multiSellers.map(([s, i]) => ({ seller: s, items: i })) };
  await fs.writeFile(`${PROJECT}\\results\\${ts}.json`, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n결과 저장: results/${ts}.json`);

  return report;
}
