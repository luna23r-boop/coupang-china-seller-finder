# 쿠팡 중국 판매자 찾기 - 프로그램 로직

## 자동화 흐름

```
1. 품목 리스트 로드 (브랜드 + 인기품목)
2. 각 품목마다:
   a. 쿠팡 홈 이동 → 10초 대기
   b. 검색어 입력 → 검색 → 8초 대기
   c. 검색 결과 DOM에서 조건 맞는 상품 URL 1개 추출 (네트워크 요청 없음):
      - 로켓직구/로켓그로스 배지 없는 것만 (일반 마켓플레이스)
      - **배송일 5일 이하는 절대 제외** (오늘 날짜기준)
- 배송일 5일 초과인 것만 대상
   d. 없으면 → "해당 품목 중국 판매자 없음" 기록, 다음 품목
   e. 있으면 → 15초 대기 후 page.goto()로 상품 페이지 이동
   f. 상품 페이지에서 추출:
      - 판매자명 (텍스트: "판매자: OOO")
      - 대표자명 (텍스트: "상호/대표자 OOO / OOO")
      - 가격
      - 배송일
      - 사이즈
   g. 중국인 판별 (대표자/상호 기준)
   h. 팝업 탭 전부 닫기
   i. 20초 대기 후 다음 품목
3. 전체 결과 정리
```

## 중국 판매자 필터 조건

### 1차 필터 (검색 결과에서, DOM만)
- 로켓직구 배지 없음 (img src에 "global", "coupang_global" 없음)
- 로켓그로스/판매자로켓 배지 없음 (img src에 "rocket_merchant", "rocket_growth" 없음)
- 배송일 7일 이상 (배송일 짧으면 국내 판매자 가능성 높음)

### 2차 필터 (상품 상세 페이지에서)
판매자 정보의 "상호/대표자"를 확인하여 중국인 여부 판별:

| 패턴 | 예시 | 판별 |
|------|------|------|
| 상호에 "유한회사" | 루오엘 유한회사 | 중국 법인 |
| 상호에 "트레이딩/무역" | OO트레이딩 | 중국 수입상 |
| 대표자 핑인 영문 | LUO JIAJIA, ZHANG XIA | 중국인 |
| 대표자 중국어 한자 | 张三 | 중국인 |
| 대표자 중국식 한글 | 왕웨이, 류칭 | 중국인 |
| 상호 Co.,Ltd (주식회사 없이) | NOIRIC Co.,Ltd. | 중국식 |

### 가격 필터
- 같은 상품의 다른 판매자 중 **최저가 대비 50% 초과는 제외**
- 예: 최저가 85,440원 → 128,160원 초과 판매자 제외
- 계산: `maxPrice = lowestPrice * 1.5`

### 중국 판매자 판별 보충
- "유한회사", "트레이딩" 같은 명확한 패턴 외에도
- "춘향" 같이 이름만으로는 판별 어려운 중국 판매자도 있음
- 가격대 내 판매자 중 판별 불확실한 경우 → 상품페이지에서 대표자명 확인 필요

### 교차 분석 (핵심)
- 각 품목별로 "다른 판매자 보기" 클릭하여 전체 판매자 목록 추출
- 중국 판매자만 필터 + 가격 20% 룰 적용
- 여러 품목에 걸쳐 등장하는 중국 판매자를 찾음
- **같은 판매자 + 서로 다른 품목 + 서로 다른 사이즈** 조합만 리스트업

### 한국인으로 판단하는 경우
| 패턴 | 예시 | 판별 |
|------|------|------|
| 대표자 한국식 이름 | 김낙구, 이계화 | 한국인 |
| "주식회사" 포함 | 주식회사 노이릭 | 한국 법인 |
| 배송 7일 미만 | 내일 도착, 3일 후 | 국내 발송 가능성 |

## 판매자 캐시 (효율화 핵심)

한번 확인한 판매자는 결과를 저장해서 다시 접속하지 않는다.

```
seller_cache.json 예시:
{
  "유니온링크": { "rep": "김낙구", "isChinese": false },
  "루오엘 유한회사": { "rep": "LUO JIAJIA", "isChinese": true },
  "함께공간": { "rep": "이화순", "isChinese": false },
  "춘향": { "rep": "?", "isChinese": true },
  ...
}
```

### 동작 방식
1. "다른 판매자 보기"에서 판매자명 추출
2. seller_cache.json에 있는지 확인
3. **있으면 → 캐시된 결과 사용 (접속 안 함)**
4. 없으면 → 상품페이지 접속해서 대표자 확인 → 결과 캐시에 저장

### 제외 대상 (접속 안 함)
- 캐시에 isChinese: false로 저장된 판매자
- 최저가 대비 50% 초과 판매자
- 로켓직구/로켓그로스 상품
- 배송일 7일 미만 상품

## 봇차단 방지 규칙 (절대 위반 금지)

1. **fetch() API 절대 사용 금지** - 쿠팡이 즉시 탐지
2. **한번에 탭 1개만** - 병렬 열기 금지
3. **페이지 이동 사이 최소 15~20초 대기**
4. **팝업 탭 즉시 닫기** - 열린 채로 두면 추가 요청 발생
5. **한 품목당 페이지 1개만 방문** - 반복 시도 금지
6. **차단 감지 시 즉시 중단** - "사용권한이 없습니다" 텍스트 확인

## DOM에서 배지 판별법

```js
const srcs = Array.from(el.querySelectorAll('img')).map(im => im.src || '');
const isRocketGrowth = srcs.some(s => s.includes('rocket_merchant') || s.includes('rocket_growth'));
const isRocketGlobal = srcs.some(s => s.includes('global') || s.includes('coupang_global'));
const isRegular = !isRocketGrowth && !isRocketGlobal;
```

## DOM에서 배송일 계산법

```js
const txt = el.textContent;
const dm = txt.match(/(\d+)\/(\d+)/);
if (dm) {
  const d = new Date(today.getFullYear(), parseInt(dm[1])-1, parseInt(dm[2]));
  const days = Math.round((d - today) / 86400000);
  // days >= 7 이면 해외발송 가능성
}
```

## 상품 페이지에서 데이터 추출

```js
const txt = document.body.innerText;

// 판매자명
const seller = (txt.match(/판매자:\s*([^\n]{2,80})/) || [])[1]
  ?.trim().replace(/판매자\s*평가.*$/,'').replace(/\s*다른 판매자.*$/,'').trim();

// 대표자명
const rm = txt.match(/상호\/?대표자\s*([^\n]{2,100})/);
let rep = null;
if (rm) {
  const parts = rm[1].split('/').map(s => s.trim());
  rep = parts.length >= 2 ? parts[parts.length - 1] : null;
}

// 가격
const price = (txt.match(/(\d{1,3}(,\d{3})+)원/) || [])[0];

// 배송일
const delivery = (txt.match(/((\d+)\/(\d+)\s*(\(.*?\))?\s*도착\s*예정|내일.*?도착)/) || [])[0];

// 사이즈
const size = (txt.match(/신발사이즈:\s*(\d{2,3})/) || [])[1];
```
