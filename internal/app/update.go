package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ReleaseRepo is the default repository used to check releases and self-updates.
const ReleaseRepo = "ElJoker63/gemini-web2api-go"

type GitHubRelease struct {
	TagName     string        `json:"tag_name"`
	Name        string        `json:"name"`
	Body        string        `json:"body"`
	PublishedAt string        `json:"published_at"`
	HTMLURL     string        `json:"html_url"`
	Assets      []GitHubAsset `json:"assets"`
}

type GitHubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type UpdateCheckResult struct {
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	HasUpdate      bool   `json:"has_update"`
	ReleaseNotes   string `json:"release_notes"`
	ReleaseURL     string `json:"release_url"`
	DownloadURL    string `json:"download_url"`
	AssetName      string `json:"asset_name"`
}

// CheckForUpdate queries GitHub for the latest release and matches the current OS/ARCH asset.
func CheckForUpdate() (*UpdateCheckResult, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", ReleaseRepo)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "gemini-web2api-go/"+Version)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned HTTP %d", resp.StatusCode)
	}

	var rel GitHubRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, err
	}

	latestVer := strings.TrimPrefix(rel.TagName, "v")
	currentVer := strings.TrimPrefix(Version, "v")
	hasUpdate := verCompare(latestVer, currentVer) > 0

	var downloadURL, assetName string
	targetOS := runtime.GOOS
	targetArch := runtime.GOARCH

	for _, a := range rel.Assets {
		lower := strings.ToLower(a.Name)
		if strings.Contains(lower, "sha256") {
			continue
		}
		if strings.Contains(lower, targetOS) && strings.Contains(lower, targetArch) {
			if targetOS == "windows" && !strings.HasSuffix(lower, ".exe") {
				continue
			}
			downloadURL = a.BrowserDownloadURL
			assetName = a.Name
			break
		}
	}

	return &UpdateCheckResult{
		CurrentVersion: currentVer,
		LatestVersion:  latestVer,
		HasUpdate:      hasUpdate,
		ReleaseNotes:   rel.Body,
		ReleaseURL:     rel.HTMLURL,
		DownloadURL:    downloadURL,
		AssetName:      assetName,
	}, nil
}

// ApplyUpdate downloads the new binary from downloadURL and atomically replaces the running binary.
func ApplyUpdate(downloadURL string) error {
	if downloadURL == "" {
		return fmt.Errorf("empty download URL")
	}

	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return fmt.Errorf("failed to resolve executable symlink: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with HTTP %d", resp.StatusCode)
	}

	execDir := filepath.Dir(execPath)
	tmpFile, err := os.CreateTemp(execDir, "gemini-proxy-update-*")
	if err != nil {
		tmpFile, err = os.CreateTemp("", "gemini-proxy-update-*")
		if err != nil {
			return fmt.Errorf("failed to create temp file: %w", err)
		}
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to write update file: %w", err)
	}
	tmpFile.Close()

	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpPath, 0755); err != nil {
			return fmt.Errorf("failed to chmod binary: %w", err)
		}
	}

	if runtime.GOOS == "windows" {
		oldPath := execPath + ".old"
		_ = os.Remove(oldPath)
		if err := os.Rename(execPath, oldPath); err != nil {
			return fmt.Errorf("failed to rename current binary: %w", err)
		}
		if err := os.Rename(tmpPath, execPath); err != nil {
			_ = os.Rename(oldPath, execPath)
			return fmt.Errorf("failed to replace binary: %w", err)
		}
	} else {
		if err := os.Rename(tmpPath, execPath); err != nil {
			destTmp := filepath.Join(execDir, fmt.Sprintf(".gemini-update-%d.tmp", time.Now().UnixNano()))
			in, cpErr := os.Open(tmpPath)
			if cpErr != nil {
				return fmt.Errorf("failed to open downloaded temp file: %w", cpErr)
			}
			out, cpErr := os.OpenFile(destTmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
			if cpErr != nil {
				in.Close()
				return fmt.Errorf("failed to create destination temp file: %w", cpErr)
			}
			_, _ = io.Copy(out, in)
			in.Close()
			out.Close()

			if err = os.Rename(destTmp, execPath); err != nil {
				_ = os.Remove(destTmp)
				return fmt.Errorf("failed to overwrite binary: %w", err)
			}
		}
	}

	return nil
}

// PerformSelfUpdate checks and executes the self-update.
func PerformSelfUpdate() error {
	fmt.Printf("Checking for updates from %s...\n", ReleaseRepo)
	res, err := CheckForUpdate()
	if err != nil {
		return fmt.Errorf("update check failed: %w", err)
	}

	fmt.Printf("Current version: v%s | Latest version: v%s\n", res.CurrentVersion, res.LatestVersion)
	if !res.HasUpdate {
		fmt.Println("Already running the latest version.")
		return nil
	}

	if res.DownloadURL == "" {
		return fmt.Errorf("no matching binary asset found for %s/%s in release v%s", runtime.GOOS, runtime.GOARCH, res.LatestVersion)
	}

	fmt.Printf("Downloading %s from %s...\n", res.AssetName, res.DownloadURL)
	if err := ApplyUpdate(res.DownloadURL); err != nil {
		return fmt.Errorf("failed to apply update: %w", err)
	}

	fmt.Printf("Successfully updated to v%s! Please restart gemini-proxy to apply.\n", res.LatestVersion)
	return nil
}

func verCompare(a, b string) int {
	pa := parseVersionParts(a)
	pb := parseVersionParts(b)
	maxLen := len(pa)
	if len(pb) > maxLen {
		maxLen = len(pb)
	}
	for i := 0; i < maxLen; i++ {
		va, vb := 0, 0
		if i < len(pa) {
			va = pa[i]
		}
		if i < len(pb) {
			vb = pb[i]
		}
		if va != vb {
			return va - vb
		}
	}
	return 0
}

func parseVersionParts(v string) []int {
	v = strings.TrimPrefix(v, "v")
	parts := strings.Split(v, ".")
	res := make([]int, 0, len(parts))
	for _, p := range parts {
		var n int
		fmt.Sscanf(p, "%d", &n)
		res = append(res, n)
	}
	return res
}
