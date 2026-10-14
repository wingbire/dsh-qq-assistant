const line = function (o) { process.stdout.write(JSON.stringify(o) + String.fromCharCode(10)); };
const task = process.argv[process.argv.length - 1] || "";
const isHigh = task.includes("档位：详细") || task.includes("字数上限：200");
line({ type: "status", phase: "session_start", sessionId: "mock-session-1" });
line({ type: "status", phase: "step_end", usage: { inputTokens: isHigh ? 350 : 127, outputTokens: isHigh ? 232 : 45, cacheReadTokens: isHigh ? 1100 : 1000, cacheWriteTokens: isHigh ? 520 : 90, totalTokens: 0 } });
process.stdout.write((isHigh ? "这个报错的成因是配置文件路径没转义，按下面三步改就行。" : "我上次也卡这儿，换把武器就好了。") + String.fromCharCode(10));
line({ type: "status", phase: "session_end" });
process.exit(0);
