// Shows the disconnect confirmation dialog of this OS once and prints how its answer was read.
// Usage: npx tsx scripts/try-dialog.ts [label]
import { askWithSystemDialog } from "../src/dialog.js";

const answer = await askWithSystemDialog('"테스트 워크스페이스" 연결을 해제할까요? (시험용, 아무것도 지우지 않습니다)');
console.log(`${process.argv[2] ?? "dialog"} -> ${answer}`);
