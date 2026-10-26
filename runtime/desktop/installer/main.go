// ChatDSH Windows 安装器。
//
// 这是一个单文件自解压安装器：zip 载荷追加在 exe 末尾，安装时解压到
// %LOCALAPPDATA%\Programs\ChatDSH，创建桌面与开始菜单快捷方式，然后启动应用。
// 第二次运行会检测到已安装，直接启动，不再重复解压。
//
// 载荷格式：zip 数据 + 16 字节魔数 "CHATDSHZIP000001" + uint64 小端载荷长度。
package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	footerSize = 24
	magic      = "CHATDSHZIP000001"
)

func main() {
	fmt.Println("ChatDSH 安装器")
	installDir, err := targetDir()
	if err != nil {
		fail(err)
	}
	appPath := filepath.Join(installDir, "ChatDSH.exe")
	if _, statErr := os.Stat(appPath); statErr == nil && !hasFlag("--force") {
		fmt.Printf("检测到已安装：%s\n", installDir)
		createShortcuts(installDir, appPath)
		launch(appPath, installDir)
		return
	}

	payload, payloadSize, err := openPayload()
	if err != nil {
		fail(err)
	}
	reader, err := zip.NewReader(payload, payloadSize)
	if err != nil {
		fail(fmt.Errorf("读取安装包失败：%w", err))
	}

	fmt.Printf("安装到：%s\n", installDir)
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		fail(err)
	}
	if err := extract(reader, installDir); err != nil {
		fail(err)
	}
	writeUninstaller(installDir)
	createShortcuts(installDir, appPath)
	fmt.Println("安装完成，正在启动 ChatDSH…")
	launch(appPath, installDir)
}

// targetDir 返回安装目录；CHATDSH_INSTALL_DIR 可覆盖默认位置。
func targetDir() (string, error) {
	if override := os.Getenv("CHATDSH_INSTALL_DIR"); override != "" {
		return filepath.Clean(override), nil
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		local = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(local, "Programs", "ChatDSH"), nil
}

// openPayload 定位 exe 末尾追加的 zip 载荷。
func openPayload() (*io.SectionReader, int64, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, 0, err
	}
	file, err := os.Open(exe)
	if err != nil {
		return nil, 0, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, 0, err
	}
	if info.Size() < footerSize {
		return nil, 0, fmt.Errorf("安装包不完整")
	}
	footer := make([]byte, footerSize)
	if _, err := file.ReadAt(footer, info.Size()-footerSize); err != nil {
		return nil, 0, err
	}
	if !bytes.Equal(footer[:16], []byte(magic)) {
		return nil, 0, fmt.Errorf("找不到安装载荷")
	}
	size := int64(binary.LittleEndian.Uint64(footer[16:]))
	if size <= 0 || size > info.Size()-footerSize {
		return nil, 0, fmt.Errorf("安装载荷长度不合法：%d", size)
	}
	return io.NewSectionReader(file, info.Size()-footerSize-size, size), size, nil
}

// extract 解压 zip 内容，跳过越界路径。
func extract(reader *zip.Reader, dir string) error {
	var files, dirs int
	var bytesWritten uint64
	root := filepath.Clean(dir) + string(os.PathSeparator)
	for _, entry := range reader.File {
		name := strings.TrimPrefix(filepath.ToSlash(entry.Name), "./")
		if name == "" {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		if !strings.HasPrefix(target, root) && target != filepath.Clean(dir) {
			continue
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			dirs++
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			source.Close()
			return err
		}
		written, copyErr := io.Copy(out, source)
		source.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		files++
		bytesWritten += uint64(written)
		if files%1000 == 0 {
			fmt.Printf("  已解压 %d 个文件（%d MB）\n", files, bytesWritten/1024/1024)
		}
	}
	fmt.Printf("  解压完成：%d 个文件，%d 个目录，%d MB\n", files, dirs, bytesWritten/1024/1024)
	return nil
}

// createShortcuts 用 PowerShell 的 WScript.Shell 创建桌面与开始菜单快捷方式。
func createShortcuts(installDir, appPath string) {
	quote := func(value string) string { return strings.ReplaceAll(value, "'", "''") }
	script := fmt.Sprintf(`
$ErrorActionPreference = 'SilentlyContinue'
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @("$env:USERPROFILE\Desktop", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")) {
  $path = Join-Path $dir 'ChatDSH.lnk'
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = '%s'
  $s.WorkingDirectory = '%s'
  $s.Description = 'ChatDSH'
  $s.Save()
}
`, quote(appPath), quote(installDir))
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	_ = cmd.Run()
}

// writeUninstaller 写一个简单的 PowerShell 卸载脚本。
func writeUninstaller(installDir string) {
	script := fmt.Sprintf(`$ErrorActionPreference = 'SilentlyContinue'
Remove-Item '%s' -Recurse -Force
Remove-Item (Join-Path $env:USERPROFILE 'Desktop\ChatDSH.lnk') -Force
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ChatDSH.lnk') -Force
`, strings.ReplaceAll(installDir, "'", "''"))
	_ = os.WriteFile(filepath.Join(installDir, "Uninstall.ps1"), []byte(script), 0o644)
}

// launch 启动应用并立即退出安装器，让控制台关闭。
func launch(appPath, installDir string) {
	cmd := exec.Command(appPath)
	cmd.Dir = installDir
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		fail(fmt.Errorf("无法启动 ChatDSH：%w", err))
	}
	fmt.Println("ChatDSH 已启动。")
}

// hasFlag 判断命令行是否带某个开关。
func hasFlag(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "安装失败：%v\n", err)
	os.Exit(1)
}
