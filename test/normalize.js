const h = require('../src/cc-history');

const cases = [
  ['d:\\Git\\kabby\\', 'D:\\Git\\kabby', 'D--Git-kabby'],
  ['D:\\Git\\kabby', 'D:\\Git\\kabby', 'D--Git-kabby'],
  ['d:/Git/kabby/', 'D:/Git/kabby', 'D--Git-kabby'],
  // 底線也要換 '-'，根據用戶驗證的 cc 行為
  ['D:\\Work\\my_app\\game\\', 'D:\\Work\\my_app\\game', 'D--Work-my-app-game'],
  ['D:\\Work\\my_app', 'D:\\Work\\my_app', 'D--Work-my-app'],
  // 點號也要換
  ['D:\\Git\\claude-code-2.1.88', 'D:\\Git\\claude-code-2.1.88', 'D--Git-claude-code-2-1-88'],
];
let fails = 0;
for (const [input, expectNorm, expectEnc] of cases) {
  const n = h.normalizeCwd(input);
  const e = h.encodeCwd(input);
  const ok = n === expectNorm && e === expectEnc;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${JSON.stringify(input).padEnd(40)} → ${JSON.stringify(n)} / ${e}`);
  if (!ok) {
    console.log(`        expected: ${JSON.stringify(expectNorm)} / ${expectEnc}`);
    fails++;
  }
}
process.exit(fails ? 1 : 0);
