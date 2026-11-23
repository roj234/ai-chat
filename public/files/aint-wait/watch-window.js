/**
 * 等待 Windows 窗口：出现 / 消失 / 进入前台。
 *
 * 参数：
 *   --title <片段>     窗口标题包含（不区分大小写）
 *   --hwnd <句柄>      精确匹配窗口句柄
 *   --process <名称>   进程名包含（不区分大小写）
 *   --state appeared|missing|foreground   默认 appeared
 *   --all              包含不可见窗口
 *   --list             只枚举一次，列出匹配的窗口（不限状态）
 */
import {reset, Shell, Wait} from 'tools';

// ─── 参数 ────────────────────────────────────────────────

const argv = process.argv;
const raw = {};
for (let i = 0; i < argv.length; i++) {
	const a = String(argv[i]);
	if (!a.startsWith('--')) continue;
	const eq = a.indexOf('=');
	if (eq > 0) {
		raw[a.slice(2, eq)] = a.slice(eq + 1);
	} else {
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next == null || String(next).startsWith('--')) raw[key] = true;
		else raw[key] = argv[++i];
	}
}

const state = String(raw.state || 'appeared');
const wantTitle = raw.title == null || raw.title === true ? '' : String(raw.title);
const wantProcess = raw.process == null || raw.process === true ? '' : String(raw.process);
const wantHwnd = raw.hwnd == null || raw.hwnd === true ? 0 : Number(raw.hwnd);
const visibleOnly = !raw.all;
const listMode = raw.list === true;

const fail = (msg) => { throw new Error(msg); };

const POLL_MS = 250;

// ─── 窗口枚举（PowerShell：进程内循环轮询，只回传结论 + 快照）───

const psQuote = s => String(s).replace(/'/g, "''");
const buildCommand = (sliceMs) => {
	const ps = `
$ErrorActionPreference = 'Stop'
$wantTitle = '${psQuote(wantTitle)}'
$wantName = '${psQuote(wantProcess)}'
$wantHwnd = ${wantHwnd | 0}
$visibleOnly = $${visibleOnly ? 'true' : 'false'}
$state = '${psQuote(listMode ? 'list' : state)}'
$timeoutMs = ${sliceMs | 0}
$pollMs = ${POLL_MS | 0}
$procNames = @{}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
	public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
	[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
	[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
	[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);
	[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

function Get-WindowList {
	$found = New-Object System.Collections.ArrayList
	$cb = [W+EnumWindowsProc]{
		param($h, $l)
		$len = [W]::GetWindowTextLength($h)
		if ($len -le 0) { return $true }
		if ($visibleOnly -and -not [W]::IsWindowVisible($h)) { return $true }
		if ($wantHwnd -ne 0 -and [int64]$h -ne $wantHwnd) { return $true }

		$sb = New-Object System.Text.StringBuilder ($len + 1)
		[W]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
		$title = $sb.ToString()
		if ($wantTitle -ne '' -and -not $title.ToLower().Contains($wantTitle.ToLower())) { return $true }

		$procId = 0
		[W]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
		if ($wantName -ne '') {
			if (-not $procNames.ContainsKey($procId)) {
				try { $procNames[$procId] = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procNames[$procId] = '' }
			}
			$pn = $procNames[$procId]
			if (-not $pn -or -not $pn.ToLower().Contains($wantName.ToLower())) { return $true }
		} else {
			$pn = ''
		}

		$null = $found.Add([pscustomobject]@{
			hwnd = [int64]$h
			title = $title
			visible = [W]::IsWindowVisible($h)
			pid = $procId
			proc = $pn
		})
		return $true
	}
	[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
	return ,$found
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$polls = 0
$verdict = 'timeout'
$fg = 0
$win = @()
while ($true) {
	$polls++
	$found = Get-WindowList
	$fg = [int64][W]::GetForegroundWindow()
	$win = @($found | Select-Object -First 20)

	if ($state -eq 'appeared' -and $win.Count -gt 0) { $verdict = 'appeared'; break }
	if ($state -eq 'missing' -and $win.Count -eq 0) { $verdict = 'missing'; break }
	if ($state -eq 'foreground' -and $fg -ne 0 -and (@($win | Where-Object { $_.hwnd -eq $fg }).Count -gt 0)) { $verdict = 'foreground'; break }
	if ($state -eq 'list') { $verdict = 'list'; break }
	if ($sw.ElapsedMilliseconds -ge $timeoutMs) { break }
	Start-Sleep -Milliseconds $pollMs
}
$sw.Stop()

@{ done = ($verdict -ne 'timeout'); verdict = $verdict; elapsedMs = [int64]$sw.ElapsedMilliseconds; polls = $polls; fg = $fg; windows = $win } | ConvertTo-Json -Compress -Depth 4
`;
	const encoded = Buffer.from(ps, 'utf16le').toString('base64');
	// -EncodedCommand 免去 bash / powershell 之间的引号地狱
	return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
};

// PowerShell 在被重定向时会把错误以 CLIXML（#< CLIXML + <Objs>...）形式喷到输出里，
// 这里整块剥掉，只留真正的 stdout。
const stripClixml = text => String(text)
	.replace(/#<\s*CLIXML[^\n]*\n?/g, '')
	.replace(/<Objs\b[\s\S]*?<\/Objs>\s*/g, '')
	.replace(/<!\[CDATA\[|\]\]>/g, '');

/** @returns {Promise<{done:boolean, verdict:string, elapsedMs:number, polls:number, fg:number, windows:Array}|null>} */
const poll = async (sliceMs) => {
	const res = await Shell({ explanation: "轮询 Windows 窗口",  command: buildCommand(sliceMs) });
	const text = stripClixml(typeof res?.content === 'string' ? res.content : '');
	const start = text.indexOf('{');
	if (start < 0) return null;
	try {
		const data = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
		return {
			done: !!data.done,
			verdict: String(data.verdict || 'timeout'),
			elapsedMs: Number(data.elapsedMs) || 0,
			polls: Number(data.polls) || 0,
			fg: Number(data.fg) || 0,
			windows: Array.isArray(data.windows) ? data.windows : data.windows ? [data.windows] : []
		};
	} catch {
		return null;
	}
};

const describe = w => `"${w.title}" (HWND: ${w.hwnd}, PID: ${w.pid}${w.proc ? ', 进程: ' + w.proc : ''})`;

// ─── 主体 ────────────────────────────────────────────────

let hasEvent = false;
const waitForEvent = Wait({ duration: 0 }).then(() => hasEvent = true);

async function main() {
	if (!listMode && !wantTitle && !wantProcess && !wantHwnd) fail("`--title`、`--hwnd`、`--process` 至少需要一个（`--list` 除外）");
	if (!['appeared', 'missing', 'foreground'].includes(state)) fail("`--state` 只能是 appeared / missing / foreground");
	if (wantHwnd && !Number.isFinite(wantHwnd)) fail("`--hwnd` 必须是整数");

	if (listMode) {
		const data = await poll(0);
		if (!data) return "枚举失败";
		if (!data.windows.length) return "没有匹配的窗口";
		return data.windows.map(w => `${w.visible ? '' : '[隐藏] '}${describe(w)}`).join('\n');
	}

	const budget = Number(process.env.SCRIPT_TIMEOUT);
	const started = Date.now();
	const deadline = started + budget - 5000;
	let lastNote = '';

	while (!hasEvent) {
		const remain = deadline - Date.now();
		if (remain <= 0) break;

		const data = await Promise.race([poll(Math.min(10000, remain)), waitForEvent.then(() => null)]);
		if (!data) {
			if (hasEvent) break;
			return '枚举失败';
		}

		await reset();

		if (data.done && data.verdict !== 'timeout') {
			if (data.verdict === 'appeared') {
				return `窗口已出现: ${describe(data.windows[0])}` + (data.windows.length > 1 ? `（另有 ${data.windows.length - 1} 个匹配）` : '');
			}
			if (data.verdict === 'missing') return `窗口已消失 (${Date.now() - started}ms)`;
			return `窗口已在前台: ${describe(data.windows.find(w => w.hwnd === data.fg) || data.windows[0])}`;
		}
		lastNote = data.windows.length
			? `匹配到 ${data.windows.length} 个窗口，第一个是 ${describe(data.windows[0])}，但不在前台（fg=${data.fg}）`
			: '没有匹配的窗口';
	}
	return `等待${hasEvent ? '被异步通知打断' : '超时'} (${Date.now() - started}ms)：${lastNote}`;
}

console.log(await main());
