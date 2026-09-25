/**
 * 쿠팡 중국 판매자 찾기 v3
 * =========================
 * 56개 브랜드 × 9개 카테고리 자동 검색
 * 
 * 실행: eval(await fs.readFile('.../index.js','utf-8')); await main(page);
 * 
 * 필터:
 *   - 로켓직구/그로스 제외
 *   - 배송 5일 이내 제외 (내일도착/오늘도착 포함)
 *   - 가격 5만원 미만 제외
 *   - 해외배송(개인통관고유부호) 제외
 *   - 최저가 50% 초과 제외
 *   - 캐시된 한국인/해외배송 판매자 스킵
 *   - 30페이지까지 스캔, 16일+ 배송 우선
 */

const PROJECT = 'C:\\Users\\luna2\\.aside\\u\\0\\projects\\coupang-china-seller-finder';
const MAX_PAGES = 30;
const MIN_PRICE = 50000;

// ─── 유틸 ───
async function loadCache() { try{return JSON.parse(await fs.readFile(`${PROJECT}\\seller_cache.json`,'utf-8'))}catch(e){return{}} }
async function saveCache(c) { await fs.writeFile(`${PROJECT}\\seller_cache.json`,JSON.stringify(c,null,2),'utf-8') }
async function loadProducts() { return JSON.parse(await fs.readFile(`${PROJECT}\\products.json`,'utf-8')) }
function rDelay() { return 15000 + Math.floor(Math.random()*10000) }
async function cleanTabs() { while(tabs.length>1){try{await closeTab(tabs[tabs.length-1])}catch(e){}} }

function isChinese(seller, rep) {
  if(seller){
    if(/[\u4e00-\u9fff]/.test(seller)) return '판매자명 중국어';
    if(/유한회사/.test(seller)) return '유한회사(중국법인)';
    if(/트레이딩|무역|trading/i.test(seller)) return '트레이딩/무역';
    if(/Co\.?,?\s*Ltd/i.test(seller)&&!/주식회사/.test(seller)) return '중국식 영문상호';
  }
  if(rep){
    if(/[\u4e00-\u9fff]/.test(rep)) return '대표자 중국어';
    // 한글 대표자: 3글자+한국성씨 아니면 중국인 간주
    const krSurnames='김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남노하곽성차주우구민나진지엄채원천방공현도';
    if(/^[가-힣]{2,4}$/.test(rep) && !krSurnames.includes(rep[0])) return `대표자 비한국성씨(${rep})`;
    if(/^[가-힣]$/.test(rep) || rep.length===1) return `대표자 1글자(${rep})`;
    // 영문 대표자: 모두 핑인 체크
    if(/^[A-Z]/i.test(rep) && !/^(KIM|LEE|PARK|CHOI|JUNG|KANG|CHO|YOON|JANG|LIM|HAN|OH|SEO|SHIN|KWON|HWANG|AHN|SONG|RYU|JEON|HONG)/i.test(rep)) return `대표자 핑인(${rep})`;
    if(/^(왕|리|류|장|진|마|후|쿠|치|동|딩|방|우|펀|파|런|궈|루|란|웨|러|쉬|탕|셴)/.test(rep)) return `대표자 중국식(${rep})`;
    if(/^(LUO|WANG|LI|ZHANG|CHEN|LIU|YANG|HUANG|ZHAO|WU|ZHOU|XU|SUN|MA|HU|GUO|LIN|HE|LU|TANG|DENG|FENG|XIAO|CHENG|PAN|YUAN|JIANG|GONG|XUAN|DONG|HAN|ZHU)/i.test(rep)) return `대표자 핑인(${rep})`;
  }
  return null;
}

// ─── 검색 결과 스캔 (30페이지, DOM만) ───
async function scanPages(pg, query) {
  await pg.goto('https://www.coupang.com/np/search?q='+encodeURIComponent(query));
  await sleep(6000);
  
  let all = [];
  for(let p=1; p<=MAX_PAGES; p++){
    const items = await pg.evaluate((minP) => {
      const today=new Date(); today.setHours(0,0,0,0);
      const r=[];
      for(const el of document.querySelectorAll('li.ProductUnit_productUnit__Qd6sv')){
        const srcs=Array.from(el.querySelectorAll('img')).map(im=>im.src||'');
        if(srcs.some(s=>s.includes('rocket')||s.includes('global'))) continue;
        const txt=el.textContent;
        if(txt.includes('내일')&&txt.includes('도착')) continue;
        if(txt.includes('오늘')&&txt.includes('도착')) continue;
        const dm=txt.match(/(\d+)\/(\d+)/);
        if(!dm) continue;
        const d=new Date(today.getFullYear(),parseInt(dm[1])-1,parseInt(dm[2]));
        if(d<today) d.setFullYear(d.getFullYear()+1);
        const days=Math.round((d-today)/86400000);
        if(days<=5) continue;
        const prAll=txt.match(/\d{1,3}(,\d{3})+원/g)||[];
        let price=0;
        for(const pr of prAll){const v=parseInt(pr.replace(/[,원]/g,''));if(v>=minP){price=v;break;}}
        if(price<minP) continue;
        const a=el.querySelector('a[href*="/vp/"]');
        const name=el.querySelector('img')?.alt?.substring(0,60);
        r.push({name,price,priceText:price.toLocaleString()+'원',days,href:a?.href});
      }
      return r;
    }, MIN_PRICE);
    
    all.push(...items);
    if(all.filter(i=>i.days>=16).length>=3) break;
    
    const hasNext=await pg.evaluate(()=>{
      const b=document.querySelectorAll('button.nextBtn.active');
      if(b.length>0){b[b.length-1].click();return true;} return false;
    });
    if(!hasNext) break;
    await sleep(3000);
  }
  return all.sort((a,b)=>b.days-a.days);
}

// ─── 상품 페이지에서 판매자 정보 + 해외배송 체크 + 다른 판매자 vendorItemId ───
async function checkProduct(pg, url, cache) {
  await pg.goto(url, {waitUntil:'domcontentloaded',timeout:15000});
  await sleep(5000);
  await cleanTabs();
  
  const info = await pg.evaluate(()=>{
    const t=document.body.innerText;
    if(t.includes('사용권한')) return {error:'blocked'};
    const isOverseas=t.includes('개인통관고유부호')||t.includes('해외 배송 상품');
    const pid=location.href.match(/products\/(\d+)/)?.[1];
    const title=document.querySelector('h1')?.textContent?.trim();
    const sm=(t.match(/판매자:\s*([^\n]{2,80})/)||[])[1]?.trim().replace(/판매자\s*평가.*/,'').replace(/\s*다른 판매자.*/,'').trim();
    const rm=t.match(/상호\/?대표자\s*([^\n]{2,100})/);
    let rep=null;if(rm){const p=rm[1].split('/').map(s=>s.trim());rep=p.length>=2?p[p.length-1]:null;}
    const pr=(t.match(/(\d{1,3}(,\d{3})+)원/)||[])[0];
    const dv=(t.match(/((\d+)\/(\d+).*?도착\s*예정)/)||[])[0];
    return {pid,title,seller:sm,rep,price:pr,delivery:dv,isOverseas};
  });
  
  if(info.error==='blocked') return {error:'blocked'};
  if(info.isOverseas) return {...info, error:'overseas'};
  
  // "다른 판매자 보기" 클릭 + vendorItemId 추출
  const sn=await snapshot(pg,{interactive:true});
  const btn=sn.tree.match(/ref=(e\d+).*다른 판매자/);
  if(btn){await pg.locator(btn[1]).click();await sleep(3000);}
  
  const sellers=await pg.evaluate(()=>{
    const pid=location.href.match(/products\/(\d+)/)?.[1];
    const rows=document.querySelectorAll('tr[data-row-key]');
    return {pid, sellers:Array.from(rows).map(r=>{
      const txt=r.textContent;
      const prM=txt.match(/(\d{1,3}(,\d{3})+)원/);
      const price=prM?parseInt(prM[1].replace(/,/g,'')):0;
      const dvM=txt.match(/((\d+)\/(\d+).*?도착\s*예정|내일.*?도착)/);
      const selM=txt.match(/도착\s*(?:예정)?\s*([가-힣a-zA-Z\s(),.]{2,60})/);
      let seller=selM?.[1]?.trim().replace(/\d+%.*$/,'').replace(/건 이하.*$/,'').trim();
      return {vid:r.getAttribute('data-row-key'),seller,price,priceText:prM?.[0]||'',delivery:dvM?.[0]||''};
    }).filter(s=>s.price>0)};
  });
  
  return {...info, allSellers:sellers.sellers, pid:sellers.pid||info.pid};
}

// ═══════════════════════════════════
//  메인
// ═══════════════════════════════════
async function main(pg) {
  const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  쿠팡 중국 판매자 찾기 v3 - ${ts}`);
  console.log(`${'═'.repeat(50)}\n`);
  
  const {brands,categories}=await loadProducts();
  const cache=await loadCache();
  const allResults=[];
  let blocked=false;
  
  for(const brand of brands){
    if(blocked) break;
    
    for(const cat of categories){
      if(blocked) break;
      const query=`${brand} ${cat}`;
      console.log(`\n[${query}]`);
      
      // 검색 + 스캔
      await sleep(rDelay());
      const candidates=await scanPages(pg,query);
      
      // 브랜드명 포함 상품만
      const brandItems=candidates.filter(i=>{
        const n=(i.name||'').toLowerCase();
        return n.includes(brand.toLowerCase())||n.includes(brand);
      });
      
      const items16=brandItems.filter(i=>i.days>=14);
      if(!items16.length){
        console.log(`  → ${brandItems.length}개 중 14일+ 없음`);
        continue;
      }
      
      console.log(`  → ${items16.length}개 14일+ 발견 (최장 ${items16[0].days}일)`);
      
      // 배송 가장 긴 상품 1개 방문
      await sleep(rDelay());
      const data=await checkProduct(pg,items16[0].href,cache);
      
      if(data.error==='blocked'){console.log('  ⚠ 차단! 중단.');blocked=true;break;}
      if(data.error==='overseas'){
        console.log(`  ✗ 해외배송 → 제외 (${data.seller})`);
        if(data.seller) cache[data.seller]={rep:data.rep||'미확인',isChinese:false,reason:'해외배송 제외'};
        continue;
      }
      
      // 최저가 50% 필터
      const lowest=Math.min(...(data.allSellers||[]).map(s=>s.price).filter(p=>p>0));
      const maxP=lowest*1.5;
      
      // 각 판매자 판별
      const validSellers=[];
      for(const s of (data.allSellers||[])){
        if(s.price>maxP) continue;
        if(s.price<MIN_PRICE) continue;
        
        // 캐시 확인
        if(cache[s.seller]){
          const cc=cache[s.seller];
          if(cc.isChinese===false) continue;
          if(cc.isChinese===true){
            validSellers.push({
              seller:s.seller,rep:cc.rep,reason:cc.reason,
              price:s.price,priceText:s.priceText,delivery:s.delivery,vid:s.vid,
              link:`https://www.coupang.com/vp/products/${data.pid}?vendorItemId=${s.vid}`,
            });
            continue;
          }
        }
        
        // 이름 판별
        const reason=isChinese(s.seller,data.rep);
        if(reason){
          cache[s.seller]={rep:data.rep||'미확인',isChinese:true,reason};
          validSellers.push({
            seller:s.seller,rep:data.rep,reason,
            price:s.price,priceText:s.priceText,delivery:s.delivery,vid:s.vid,
            link:`https://www.coupang.com/vp/products/${data.pid}?vendorItemId=${s.vid}`,
          });
        }else{
          cache[s.seller]={rep:'미확인',isChinese:'unknown',reason:'미확인'};
        }
      }
      
      if(validSellers.length){
        console.log(`  🇨🇳 중국 판매자 ${validSellers.length}명!`);
        validSellers.forEach(s=>console.log(`     ${s.seller} | ${s.priceText} | ${s.link}`));
        allResults.push({brand,cat,query,pid:data.pid,title:data.title,status:'found',chineseSellers:validSellers});
      }
    }
    
    // 브랜드 끝날 때마다 캐시 저장
    await saveCache(cache);
  }
  
  // ─── 결과 출력 ───
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  최종 결과');
  console.log(`${'═'.repeat(50)}\n`);
  
  const found=allResults.filter(r=>r.status==='found');
  found.forEach(r=>{
    console.log(`🇨🇳 ${r.brand} ${r.cat}`);
    r.chineseSellers.forEach(s=>{
      console.log(`   ${s.seller} | ${s.priceText} | ${s.delivery}`);
      console.log(`   → ${s.link}`);
    });
    console.log('');
  });
  
  // 교차 분석
  const sMap={};
  found.forEach(r=>r.chineseSellers.forEach(s=>{
    if(!sMap[s.seller])sMap[s.seller]=[];
    sMap[s.seller].push({brand:r.brand,cat:r.cat,price:s.priceText,link:s.link});
  }));
  const multi=Object.entries(sMap).filter(([,i])=>i.length>=2);
  if(multi.length){
    console.log('같은 판매자 + 다른 품목:');
    multi.forEach(([s,items])=>{
      console.log(`\n  ✅ ${s} (${items.length}개)`);
      items.forEach(it=>console.log(`     ${it.brand} ${it.cat} | ${it.price}`));
    });
  }
  
  // 저장
  const report={runAt:new Date().toISOString(),found:found.length,results:allResults,crossSellers:multi.map(([s,i])=>({seller:s,items:i}))};
  await fs.writeFile(`${PROJECT}\\results\\${ts}.json`,JSON.stringify(report,null,2),'utf-8');
  console.log(`\n결과 저장: results/${ts}.json`);
  return report;
}
