import {spawn} from 'node:child_process';
import {pollInterval, sleep, toolError} from "./utils.js";

/** @type {AiChat.FunctionTool} */
export const WatchWindow = {
	name: 'WatchWindow',
	description: '等待某个窗口出现、消失或切到前台。',
	parameters: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: '可选，按窗口标题做不区分大小写的包含匹配',
			},
			hwnd: {
				type: 'integer',
				description: '可选，按窗口句柄精确匹配',
			},
			processName: {
				type: 'string',
				description: '可选，按进程名匹配',
			},
			state: {
				type: 'string',
				default: 'appeared',
				description: '期望的窗口状态：`appeared` 窗口出现，`missing` 窗口消失，`foreground` 窗口位于前台',
				enum: ['appeared', 'missing', 'foreground'],
			},
			timeoutMs: {
				type: 'integer',
				default: 30000,
			},
		}
	},
	async script({ title: titleFilter, hwnd, processName, state = 'appeared', timeoutMs = 30000 }) {
		const includeInvisible =  false;
		const limit = 500;

		if (!titleFilter && !hwnd && !processName) return toolError('错误：`title`、`hwnd`、`processName` 至少需要提供一个');

		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const windows = await getWindowsPowerShell(titleFilter, processName, hwnd, includeInvisible, limit);

			if (state === 'appeared' && windows.length > 0) {
				const w = windows[0];
				return `窗口已出现: "${w.title}" (HWND: ${w.hwnd}, PID: ${w.pid})`;
			}

			if (state === 'missing' && windows.length === 0) {
				return '目标窗口已消失';
			}

			if (state === 'foreground') {
				// 检查最前面的窗口
				const fgCheck = new Promise((resolve) => {
					const ps = spawn('powershell.exe', [
						'-NoProfile', '-NonInteractive',
						'-Command',
						'Add-Type -Name WinAPI -Namespace FG -MemberDefinition \'[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern int GetWindowText(IntPtr hWnd,System.Text.StringBuilder t,int c);\';$h=[FG.WinAPI]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder(512);[FG.WinAPI]::GetWindowText($h,$sb,512)|Out-Null;Write-Output "$h|$($sb.ToString())"',
					], { timeout: 5000 });

					let out = '';
					ps.stdout.on('data', (d) => { out += d.toString(); });
					ps.on('close', () => {
						const parts = out.trim().split('|');
						resolve({ hwnd: parts[0] || '', title: parts.slice(1).join('|') || '' });
					});
				});

				const fg = await fgCheck;

				const match = windows.some((w) => String(w.hwnd) === fg.hwnd);
				if (match) return `窗口已在前台: "${fg.title}" (HWND: ${fg.hwnd})`;
			}

			await sleep(pollInterval);
		}

		return "等待超时";
	}
};

/**
 * 通过 PowerShell 获取窗口列表
 * 返回 [{ hwnd, title, pid, processName, visible }]
 *
 * 一次 PowerShell 调用完成窗口枚举 + 进程名解析，避免 O(n) 子进程。
 */
function getWindowsPowerShell(titleFilter, processName, hwnd, includeInvisible, limit) {
	return new Promise((resolve) => {
		// 单个 PowerShell 脚本：枚举窗口 → 收集 PID → 批量查进程名 → 输出 JSON
		const psScript = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnumerator {
	[DllImport("user32.dll")]
	public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
	[DllImport("user32.dll")]
	public static extern bool IsWindowVisible(IntPtr hWnd);
	[DllImport("user32.dll", CharSet = CharSet.Auto)]
	public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
	[DllImport("user32.dll")]
	public static extern int GetWindowTextLength(IntPtr hWnd);
	[DllImport("user32.dll", SetLastError=true)]
	public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
	public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
public class WindowInfo {
	public IntPtr Hwnd;
	public string Title;
	public bool Visible;
	public uint Pid;
}
public class WindowList {
	public System.Collections.Generic.List<WindowInfo> Windows = new System.Collections.Generic.List<WindowInfo>();
}
"@
$list = New-Object WindowList
$callback = [WinEnumerator+EnumWindowsProc]{
	param($hWnd, $lParam)
	$len = [WinEnumerator]::GetWindowTextLength($hWnd)
	$sb = New-Object System.Text.StringBuilder($len + 1)
	[WinEnumerator]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
	$title = $sb.ToString()
	$visible = [WinEnumerator]::IsWindowVisible($hWnd)
	$pid = 0
	[WinEnumerator]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
	$info = New-Object WindowInfo
	$info.Hwnd = $hWnd
	$info.Title = $title
	$info.Visible = $visible
	$info.Pid = $pid
	$list.Windows.Add($info)
	return $true
}
[WinEnumerator]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

# 收集所有唯一 PID，批量查进程名
$pidSet = @{}
foreach ($w in $list.Windows) { if ($w.Pid -gt 0) { $pidSet[$w.Pid] = $true } }
$pidNames = @{}
foreach ($pid in $pidSet.Keys) {
	try { $n = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName; if ($n) { $pidNames[$pid] = $n } } catch {}
}

ConvertTo-Json -Compress @($list.Windows | ForEach-Object {
	@{
		hwnd = [int64]$_.Hwnd
		title = $_.Title
		visible = $_.Visible
		pid = $_.Pid
		processName = if ($pidNames.ContainsKey($_.Pid)) { $pidNames[$_.Pid] } else { "" }
	}
})
`;

		const ps = spawn('powershell.exe', [
			'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
			'-Command', psScript,
		], { timeout: 15000 });

		let stdout = '';
		let stderr = '';

		ps.stdout.on('data', (d) => { stdout += d.toString(); });
		ps.stderr.on('data', (d) => { stderr += d.toString(); });

		ps.on('close', () => {
			try {
				let windows = JSON.parse(stdout.trim() || '[]');

				// 按 HWND 精确匹配
				if (hwnd != null) {
					const h = String(hwnd);
					windows = windows.filter((w) => String(w.hwnd) === h);
				}

				// 按标题过滤（不区分大小写）
				if (titleFilter) {
					const tf = titleFilter.toLowerCase();
					windows = windows.filter((w) => w.title && w.title.toLowerCase().includes(tf));
				}

				// 按可见性过滤
				if (!includeInvisible) {
					windows = windows.filter((w) => w.visible);
				}

				// 按进程名过滤（不区分大小写）
				if (processName) {
					const pn = processName.toLowerCase();
					windows = windows.filter((w) => w.processName && w.processName.toLowerCase().includes(pn));
				}

				// 限制数量
				if (limit > 0) {
					windows = windows.slice(0, limit);
				}

				resolve(windows);
			} catch {
				resolve([]);
			}
		});

		ps.on('error', () => resolve([]));
	});
}
