# Dev helper: is the call popup genuinely above other windows?
#
#   powershell -ExecutionPolicy Bypass -File tools\check-topmost.ps1
#
# Asks Windows which window owns the pixel at the centre of the popup. That is
# the whole test, and it is the only method here that works.
#
# Three more obvious approaches all give false negatives, and each one cost
# real time:
#
#   Graphics.CopyFromScreen  - uses BitBlt, which SKIPS layered windows. A
#                              transparent Electron window is layered, so this
#                              photographs whatever is behind it and looks
#                              exactly like the popup opening underneath.
#   BitBlt with CAPTUREBLT   - meant to include layered windows; still misses
#                              DWM-composited content on Windows 10/11.
#   EnumWindows              - never lists the popup at all. Electron parents
#                              skipTaskbar windows to a hidden helper, so it
#                              is not enumerated as a top-level window.
#
# Electron's own isVisible()/isAlwaysOnTop() are no help either: both report
# true for a window that is not reaching the screen. WindowFromPoint asks the
# question that matters - what would a click at this point hit.
#
# Run it while a call is ringing:
#   ssh you@server 'docker exec dialtone-freeswitch fs_cli -P 8022 \
#     -x "originate loopback/YOUR_DID/public 9197 XML default"'

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Hit {
  public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
}
"@

Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

# Matches TOAST_W / TOAST_H and the card's own offsets in main.js.
$x = $wa.X + $wa.Width - 200
$y = $wa.Y + $wa.Height - 60

$p = New-Object Hit+POINT
$p.X = $x
$p.Y = $y

$h = [Hit]::WindowFromPoint($p)
$root = [Hit]::GetAncestor($h, 2)   # GA_ROOT
$procId = 0
[void][Hit]::GetWindowThreadProcessId($root, [ref]$procId)
$sb = New-Object Text.StringBuilder 300
[void][Hit]::GetWindowText($root, $sb, 300)
$title = $sb.ToString()
$topmost = (([Hit]::GetWindowLong($root, -20)) -band 0x8) -ne 0
$name = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '?' }

Write-Host ""
Write-Host "pixel $x,$y is owned by:"
Write-Host "  process : $name (pid $procId)"
Write-Host "  title   : $title"
Write-Host "  topmost : $topmost"
Write-Host ""

if ($title -eq 'Incoming call') {
  Write-Host "PASS - the popup owns that pixel, so it is above whatever else is there" -ForegroundColor Green
  exit 0
}

Write-Host "FAIL - '$title' is covering the popup (or no call is ringing)" -ForegroundColor Red
exit 1
