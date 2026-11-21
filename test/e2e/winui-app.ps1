# A small window for the winui test: a text box, a checkbox, a button and a result label. Closes itself after 60 s.
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.Text = 'ptk winui test ' + [char]0x6D4B + [char]0x8BD5  # Chinese in the title, without depending on the file's encoding
$f.Width = 380; $f.Height = 220
# Minimized, so it never takes keyboard focus from whoever is using the machine; UI Automation still reaches it.
$f.WindowState = 'Minimized'
$tb = New-Object Windows.Forms.TextBox
$tb.Name = 'nameBox'; $tb.AccessibleName = 'Name box'; $tb.Top = 10; $tb.Left = 10; $tb.Width = 220
$cb = New-Object Windows.Forms.CheckBox
$cb.Text = 'Agree'; $cb.Top = 40; $cb.Left = 10
$btn = New-Object Windows.Forms.Button
$btn.Text = 'Say hi'; $btn.Top = 70; $btn.Left = 10
$lbl = New-Object Windows.Forms.Label
$lbl.Name = 'result'; $lbl.Text = 'waiting'; $lbl.Top = 110; $lbl.Left = 10; $lbl.Width = 340
$btn.Add_Click({ $lbl.Text = 'hi ' + $tb.Text + ' agree=' + $cb.Checked })
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 60000; $timer.Add_Tick({ $f.Close() }); $timer.Start()
$f.Controls.AddRange(@($tb, $cb, $btn, $lbl))
[Windows.Forms.Application]::Run($f)
