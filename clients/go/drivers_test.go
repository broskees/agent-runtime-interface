// The Go client drives the real pi and acp drivers inside the standalone ari-driver (built by
// `pnpm run build:binary` into build/standalone/linux-x64/), with a PATH that holds no node and no
// bun: initialize, probe the instance, open a session, create a thread, start a turn, answer its
// approval through respond, and read events until turn.terminal completes.

package ari

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func standaloneDir(t *testing.T) string {
	if directory := os.Getenv("ARI_STANDALONE_DIR"); directory != "" {
		return directory
	}
	directory, err := filepath.Abs(filepath.Join("..", "..", "build", "standalone", "linux-x64"))
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func binary(t *testing.T, relative string) string {
	path := filepath.Join(standaloneDir(t), relative)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		t.Fatalf("%s is missing; run `pnpm run build:binary` first", path)
	}
	return path
}

type nodeFree struct{ root string }

// newNodeFree makes bin/ (only pi, the compiled fake), home/, project/ and the instance's
// state/, cache/ and tmp/ in a temp directory the test removes.
func newNodeFree(t *testing.T) nodeFree {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"bin", "home", "project", "state", "cache", "tmp"} {
		if err := os.Mkdir(filepath.Join(root, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(binary(t, "fakes/pi"), filepath.Join(root, "bin", "pi")); err != nil {
		t.Fatal(err)
	}
	for _, runtime := range []string{"node", "nodejs", "bun"} {
		if _, err := os.Stat(filepath.Join(root, "bin", runtime)); err == nil {
			t.Fatalf("the PATH must hold no %s", runtime)
		}
	}
	return nodeFree{root}
}

func (n nodeFree) path(relative string) string { return filepath.Join(n.root, relative) }

// command is ari-driver <driver> with an environment of only PATH (no node, no bun), HOME and XDG dirs.
func (n nodeFree) command(t *testing.T, driver string) *exec.Cmd {
	cmd := exec.Command(binary(t, "ari-driver"), driver)
	cmd.Dir = n.path("project")
	home := n.path("home")
	cmd.Env = []string{"PATH=" + n.path("bin"), "HOME=" + home, "XDG_CONFIG_HOME=" + home + "/.config", "XDG_DATA_HOME=" + home + "/.local/share", "XDG_STATE_HOME=" + home + "/.local/state", "XDG_CACHE_HOME=" + home + "/.cache"}
	return cmd
}

func completeATurn(t *testing.T, driver string, config map[string]any, optionID, expectedVersion string) {
	place := newNodeFree(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	instanceKey := driver + "-go"
	host := NewMemoryHost().WithConfig(instanceKey, config)
	client, err := Start(place.command(t, driver), host)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	handshake, err := client.Initialize(ctx, EnvPolicy{StripAmbient: []string{}})
	if err != nil {
		t.Fatal("initialize:", err)
	}
	if handshake.Driver.Kind != driver || handshake.GrammarVersion != 1 {
		t.Fatalf("handshake: %+v", handshake)
	}

	instance, err := client.DriverCreate(ctx, DriverCreateParams{InstanceID: instanceKey, Config: config, Environment: map[string]string{}, Paths: HostPaths{StateDir: place.path("state"), CacheDir: place.path("cache"), TmpDir: place.path("tmp")}})
	if err != nil {
		t.Fatal("driver/create:", err)
	}
	probe, err := client.InstanceProbe(ctx, InstanceProbeParams{InstanceID: instance.InstanceID})
	if err != nil {
		t.Fatal("instance/probe:", err)
	}
	if !probe.Installed || probe.Version == nil || *probe.Version != expectedVersion {
		t.Fatalf("probe: %+v", probe)
	}

	session, err := client.InstanceOpenSession(ctx, InstanceOpenSessionParams{InstanceID: instance.InstanceID})
	if err != nil {
		t.Fatal("instance/openSession:", err)
	}
	events, err := client.SessionEvents(ctx, SessionEventsParams{SessionID: session.SessionID})
	if err != nil {
		t.Fatal("session/events:", err)
	}
	project := place.path("project")
	mode := RuntimeModeApprovalRequired
	thread, err := client.SessionCreateThread(ctx, SessionCreateThreadParams{SessionID: session.SessionID, Cwd: project, Policy: RuntimePolicy{Mode: &mode, Interaction: InteractionModeDefault, Cwd: project}})
	if err != nil {
		t.Fatal("session/createThread:", err)
	}
	// The thread reports the mode it runs in, and that the host chose it.
	if thread.EffectiveMode == nil || thread.EffectiveMode.Mode == nil || *thread.EffectiveMode.Mode != RuntimeModeApprovalRequired || thread.EffectiveMode.Source != EffectiveModeSourceHost {
		t.Fatalf("effectiveMode: %+v", thread.EffectiveMode)
	}
	started, err := client.SessionStartTurn(ctx, SessionStartTurnParams{SessionID: session.SessionID, ThreadID: thread.ID, ClientTurnKey: "go-1", Intent: StartTurnIntentStart, Content: []ContentBlock{{&TextContent{Text: "Say hello"}}}})
	if err != nil {
		t.Fatal("session/startTurn:", err)
	}
	accepted, ok := started.Value.(*StartTurnResultAccepted)
	if !ok {
		t.Fatalf("the turn was not accepted: %#v", started.Value)
	}

	answered := ""
	var terminal *TurnTerminalBody
	for terminal == nil {
		select {
		case event, open := <-events.C:
			if !open {
				t.Fatalf("the event stream ended before turn.terminal: %v", events.Err())
			}
			switch body := event.Body.Value.(type) {
			case *RequestUpsertBody:
				if body.Request.Status == nil || *body.Request.Status != RequestStatusPending {
					continue
				}
				found := false
				for _, option := range body.Request.Options.Value {
					found = found || option.OptionID == optionID
				}
				if !found {
					t.Fatalf("no option %s in %+v", optionID, body.Request.Options)
				}
				if _, err := client.SessionRespond(ctx, SessionRespondParams{SessionID: session.SessionID, RequestID: body.Request.ID, ResponseKey: "go-answer", OptionID: &optionID}); err != nil {
					t.Fatal("session/respond:", err)
				}
				answered = body.Request.ID
			case *TurnTerminalBody:
				terminal = body
			}
		case <-ctx.Done():
			t.Fatal("no turn.terminal within 30 s")
		}
	}
	if terminal.TurnID != accepted.TurnID || terminal.Status != TurnTerminalStatusCompleted {
		t.Fatalf("terminal: %+v", terminal)
	}
	if answered == "" {
		t.Fatal("the approval request never reached the client")
	}
	if _, err := client.SessionClose(ctx, SessionTarget{SessionID: session.SessionID}); err != nil {
		t.Fatal("session/close:", err)
	}
	if _, err := client.InstanceDispose(ctx, InstanceTarget{InstanceID: instance.InstanceID}); err != nil {
		t.Fatal("instance/dispose:", err)
	}
	if _, err := os.Stat(place.path("home/.pi")); err == nil {
		t.Fatal("the fake pi wrote under the user's ~/.pi")
	}
}

func TestPiCompletesATurnWithAnApprovalWithoutNode(t *testing.T) {
	completeATurn(t, "pi", map[string]any{"binary": "pi", "provider": "fake", "model": "fake/fake-small"}, "allow-once", "1.6.0")
}

func TestAcpCompletesATurnWithAnApprovalWithoutNode(t *testing.T) {
	config := map[string]any{"command": binary(t, "fakes/standalone-acp-agent"), "args": []string{}, "env": map[string]string{}, "versionArgs": []string{"--version"}, "maxProtocolVersion": 1, "forkAcrossDirectories": false, "configDependencies": map[string]any{}}
	completeATurn(t, "acp", config, "allow", "1.0.0")
}
