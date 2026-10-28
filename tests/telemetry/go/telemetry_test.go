// Tests for templates/telemetry/telemetry.go. tests/telemetry-go.test.ts copies the template next
// to this file in a temp module and runs go test, go vet and gofmt there.
package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The client reads the process only through the hooks in telemetry.go. Every test starts from
// an empty environment, a fixed clock and no terminal, so the HOME, CI and agent variables of
// whoever runs the tests never reach the client.
var (
	env          map[string]string
	tty          bool
	clock        time.Time
	debugOut     bytes.Buffer
	realEndpoint = endpoint
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestMain(m *testing.M) {
	getenv = func(k string) string { return env[k] }
	testRun = func() bool { return false }
	isTerminal = func(*os.File) bool { return tty }
	now = func() time.Time { return clock }
	stderr = &debugOut
	endpoint = "http://127.0.0.1:9/unused" // a test that forgets Options.Endpoint never reaches the real one
	os.Exit(m.Run())
}

type hit struct {
	method, path string
	header       http.Header
	raw          []byte
	body         map[string]any
}

type fixture struct {
	t   *testing.T
	dir string // the state directory, not created yet
	url string
	mu  sync.Mutex
	got []hit
}

// setup resets the hooks and starts a local capture server. vars are environment pairs.
func setup(t *testing.T, vars ...string) *fixture {
	t.Helper()
	env = map[string]string{"HOME": t.TempDir()}
	for i := 0; i+1 < len(vars); i += 2 {
		env[vars[i]] = vars[i+1]
	}
	tty, testRun = false, func() bool { return false }
	clock = time.Date(2026, 10, 28, 9, 12, 3, 123_000_000, time.UTC)
	debugOut.Reset()
	f := &fixture{t: t, dir: filepath.Join(t.TempDir(), "state")}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		f.mu.Lock()
		f.got = append(f.got, hit{r.Method, r.URL.Path, r.Header.Clone(), raw, body})
		f.mu.Unlock()
	}))
	t.Cleanup(srv.Close)
	f.url = srv.URL + "/i/v0/e/"
	return f
}

func (f *fixture) opts() Options {
	return Options{
		Product:  "demo-cli",
		Version:  "1.2.3",
		StateDir: f.dir,
		Channel:  "binary",
		Features: []string{"chats list", "sync"},
		Endpoint: f.url,
	}
}

// hits waits for the requests in flight and returns them, sorted by event name: the client
// sends each event in its own goroutine, so arrival order is not fixed.
func (f *fixture) hits() []hit {
	f.t.Helper()
	Flush(2 * time.Second)
	f.mu.Lock()
	defer f.mu.Unlock()
	got := f.got
	f.got = nil
	slices.SortStableFunc(got, func(a, b hit) int { return strings.Compare(a.body["event"].(string), b.body["event"].(string)) })
	return got
}

func (f *fixture) events() []string {
	f.t.Helper()
	var names []string
	for _, h := range f.hits() {
		names = append(names, h.body["event"].(string))
	}
	return names
}

func (f *fixture) path() string { return filepath.Join(f.dir, "telemetry.json") }

// seen writes the state an earlier run leaves after showing the notice, and returns the id.
func (f *fixture) seen(st state) string {
	f.t.Helper()
	st.Notice = NoticeVersion
	if st.ID == "" {
		st.ID = "8b0e6c1a-3f0d-4a51-9a7e-2f1c5d9e4b77"
	}
	if st.Daily == nil {
		st.Daily = map[string]string{}
	}
	b, _ := json.Marshal(st)
	if err := os.MkdirAll(f.dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(f.path(), b, 0o600); err != nil {
		f.t.Fatal(err)
	}
	return string(st.ID)
}

func (f *fixture) state() (st state) {
	f.t.Helper()
	b, err := os.ReadFile(f.path())
	if err != nil {
		f.t.Fatal(err)
	}
	if err := json.Unmarshal(b, &st); err != nil {
		f.t.Fatal(err)
	}
	return st
}

func equal[T any](t *testing.T, what string, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s:\n got %#v\nwant %#v", what, got, want)
	}
}

func TestDecideRules(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name       string
		env        []string
		version    string // "" means 1.2.3; "none" means empty
		enabled    *bool
		testRun    bool
		noEndpoint bool
		on, debug  bool
		reason     string
	}{
		{name: "default", on: true, reason: "default"},
		{name: "no endpoint beats everything", noEndpoint: true, env: []string{"DEMO_CLI_TELEMETRY", "1"}, reason: "no-endpoint"},
		{name: "DO_NOT_TRACK=1", env: []string{"DO_NOT_TRACK", "1"}, reason: "do-not-track"},
		{name: "DO_NOT_TRACK=true", env: []string{"DO_NOT_TRACK", "true"}, reason: "do-not-track"},
		{name: "DO_NOT_TRACK=yes", env: []string{"DO_NOT_TRACK", "yes"}, reason: "do-not-track"},
		{name: "DO_NOT_TRACK=0", env: []string{"DO_NOT_TRACK", "0"}, on: true, reason: "default"},
		{name: "DO_NOT_TRACK=false", env: []string{"DO_NOT_TRACK", "FALSE"}, on: true, reason: "default"},
		{name: "DO_NOT_TRACK beats PREFIX=1", env: []string{"DO_NOT_TRACK", "1", "DEMO_CLI_TELEMETRY", "1"}, reason: "do-not-track"},
		{name: "PREFIX=0", env: []string{"DEMO_CLI_TELEMETRY", "0"}, reason: "env"},
		{name: "PREFIX=off", env: []string{"DEMO_CLI_TELEMETRY", "OFF"}, reason: "env"},
		{name: "PREFIX=false beats enabled", env: []string{"DEMO_CLI_TELEMETRY", "false"}, enabled: &yes, reason: "env"},
		{name: "PREFIX=debug", env: []string{"DEMO_CLI_TELEMETRY", "debug"}, on: true, debug: true, reason: "env"},
		{name: "PREFIX=1 beats CI", env: []string{"DEMO_CLI_TELEMETRY", "1", "CI", "true"}, on: true, reason: "env"},
		{name: "PREFIX=on beats a dev build", env: []string{"DEMO_CLI_TELEMETRY", "on"}, version: "dev", on: true, reason: "env"},
		{name: "PREFIX=true beats enabled false", env: []string{"DEMO_CLI_TELEMETRY", "true"}, enabled: &no, on: true, reason: "env"},
		{name: "unknown PREFIX value falls through", env: []string{"DEMO_CLI_TELEMETRY", "maybe"}, on: true, reason: "default"},
		{name: "CI=true", env: []string{"CI", "true"}, reason: "ci"},
		{name: "CI=1", env: []string{"CI", "1"}, reason: "ci"},
		{name: "CI=false", env: []string{"CI", "false"}, on: true, reason: "default"},
		{name: "blank values count as unset", env: []string{"CI", " ", "GITHUB_ACTIONS", " ", "DO_NOT_TRACK", " "}, on: true, reason: "default"},
		{name: "values are trimmed", env: []string{"CI", " False "}, on: true, reason: "default"},
		{name: "GITHUB_ACTIONS", env: []string{"GITHUB_ACTIONS", "true"}, reason: "ci"},
		{name: "GITLAB_CI", env: []string{"GITLAB_CI", "true"}, reason: "ci"},
		{name: "BUILDKITE", env: []string{"BUILDKITE", "true"}, reason: "ci"},
		{name: "CIRCLECI", env: []string{"CIRCLECI", "true"}, reason: "ci"},
		{name: "TF_BUILD", env: []string{"TF_BUILD", "True"}, reason: "ci"},
		{name: "JENKINS_URL", env: []string{"JENKINS_URL", "http://ci.example"}, reason: "ci"},
		{name: "TEAMCITY_VERSION", env: []string{"TEAMCITY_VERSION", "2026.1"}, reason: "ci"},
		{name: "CODEBUILD_BUILD_ID", env: []string{"CODEBUILD_BUILD_ID", "demo:1"}, reason: "ci"},
		{name: "CI beats enabled true", env: []string{"CI", "true"}, enabled: &yes, reason: "ci"},
		{name: "test run", testRun: true, reason: "test"},
		{name: "empty version", version: "none", reason: "dev-version"},
		{name: "dev", version: "dev", reason: "dev-version"},
		{name: "devel", version: "devel", reason: "dev-version"},
		{name: "(devel)", version: "(devel)", reason: "dev-version"},
		{name: "0.0.0", version: "0.0.0", reason: "dev-version"},
		{name: "v0.0.0", version: "v0.0.0", reason: "dev-version"},
		{name: "-dev", version: "1.3.0-dev.2", reason: "dev-version"},
		{name: "-DEV", version: "2.0.0-DEV", reason: "dev-version"},
		{name: "dev build beats enabled true", version: "dev", enabled: &yes, reason: "dev-version"},
		{name: "a tagged version", version: "v1.2.3", on: true, reason: "default"},
		{name: "a release candidate", version: "1.3.0-rc.1", on: true, reason: "default"},
		{name: "enabled false", enabled: &no, reason: "state"},
		{name: "enabled true", enabled: &yes, on: true, reason: "state"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setup(t, tc.env...)
			testRun = func() bool { return tc.testRun }
			o := Options{Product: "demo-cli", Version: "1.2.3", Endpoint: "http://127.0.0.1:9/"}
			switch tc.version {
			case "":
			case "none":
				o.Version = ""
			default:
				o.Version = tc.version
			}
			if tc.noEndpoint {
				saved := endpoint
				endpoint, o.Endpoint = "", ""
				defer func() { endpoint = saved }()
			}
			on, debug, reason := decide(defaults(o), tc.enabled)
			equal(t, "decide", []any{on, debug, reason}, []any{tc.on, tc.debug, tc.reason})
		})
	}
}

func TestRealTestRunIsDetected(t *testing.T) {
	setup(t)
	testRun = testing.Testing
	_, _, reason := decide(defaults(Options{Product: "demo-cli", Version: "1.2.3"}), nil)
	equal(t, "reason", reason, "test")
}

func TestStatusAndEnvPrefix(t *testing.T) {
	f := setup(t, "DEMO_CLI_TELEMETRY", "0")
	s := New(f.opts()).Status()
	equal(t, "status", s, Status{Reason: "env", StateFile: f.path(), Endpoint: f.url})
	env["DEMO_CLI_TELEMETRY"] = ""

	o := f.opts()
	o.EnvPrefix = "TG"
	env["TG_TELEMETRY"] = "debug"
	s = New(o).Status()
	equal(t, "custom prefix", []any{s.Enabled, s.Debug, s.Reason}, []any{true, true, "env"})

	saved := endpoint
	defer func() { endpoint = saved }()
	endpoint, o.Endpoint = "", ""
	equal(t, "packaged build", New(o).Status(), Status{Reason: "no-endpoint", StateFile: f.path()})
	equal(t, "built-in endpoint", realEndpoint, "https://usage.sergeybaus.com/i/v0/e/")
}

func TestNoticeGate(t *testing.T) {
	f := setup(t)
	var out bytes.Buffer
	c := New(f.opts())
	if c.ShowNotice(&out) || out.Len() > 0 {
		t.Fatal("notice shown with no terminal and no agent")
	}
	c.Started()
	c.Feature("sync")
	equal(t, "events before the notice", f.events(), []string(nil))
	if _, err := os.Stat(f.dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("state directory written before the notice: %v", err)
	}

	tty = true
	c = New(f.opts())
	if !c.ShowNotice(&out) {
		t.Fatal("notice not shown in a terminal")
	}
	equal(t, "notice", out.String(), "demo-cli shares usage stats with its author: how often it runs, which features are used, "+
		"errors, version and OS, tied to a random install ID. It never sends your files, arguments or account names. "+
		"Nothing has been sent yet. Turn it off with `demo-cli telemetry off` or `DO_NOT_TRACK=1`. "+
		"Details: https://usage.sergeybaus.com\n")
	out.Reset()
	if c.ShowNotice(&out) || out.Len() > 0 {
		t.Fatal("notice shown twice")
	}
	c.Started()
	c.Feature("sync")
	c.Error(errors.New("boom"))
	equal(t, "events in the run that showed the notice", f.events(), []string(nil))
	st := f.state()
	if st.Notice != NoticeVersion || !uuidV4.MatchString(string(st.ID)) || st.Installed {
		t.Fatalf("state after the notice: %+v", st)
	}

	c = New(f.opts())
	if c.ShowNotice(&out) || out.Len() > 0 {
		t.Fatal("notice shown again in the next run")
	}
	c.Started()
	equal(t, "events in the next run", f.events(), []string{"app_installed", "app_started"})
}

func TestNoticeUnderAgentAndCustomOffCommand(t *testing.T) {
	f := setup(t, "CODEX_THREAD_ID", "t-1")
	o := f.opts()
	o.Product, o.EnvPrefix, o.OffCommand = "telegram-sync-cli", "TELEGRAM_SYNC_CLI", "tg telemetry off"
	var out bytes.Buffer
	if !New(o).ShowNotice(&out) {
		t.Fatal("notice not shown under an agent")
	}
	if !strings.HasPrefix(out.String(), "telegram-sync-cli shares usage stats") || !strings.Contains(out.String(), "`tg telemetry off`") {
		t.Fatalf("notice: %q", out.String())
	}
}

func TestMarkNoticeSeen(t *testing.T) {
	f := setup(t)
	c := New(f.opts())
	want := "demo-cli shares usage stats with its author: how often it runs, which features are used, " +
		"errors, version and OS, tied to a random install ID. It never sends your files, arguments or account names. " +
		"Nothing has been sent yet. Turn it off with `demo-cli telemetry off` or `DO_NOT_TRACK=1`. " +
		"Details: https://usage.sergeybaus.com"
	equal(t, "notice text while due", c.NoticeText(), want)
	if _, err := os.Stat(f.dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("NoticeText wrote the state: %v", err)
	}
	c.MarkNoticeSeen()
	equal(t, "notice text once seen", c.NoticeText(), "")
	c.Started()
	equal(t, "events in the run that marked it", f.events(), []string(nil))
	if st := f.state(); st.Notice != NoticeVersion || !uuidV4.MatchString(string(st.ID)) {
		t.Fatalf("state: %+v", st)
	}
	next := New(f.opts())
	next.MarkNoticeSeen() // already seen: does not silence this run
	next.Started()
	equal(t, "events in the next run", f.events(), []string{"app_installed", "app_started"})
}

func TestEnvOverrideAfterOffSendsUnderANewID(t *testing.T) {
	f := setup(t, "CLAUDECODE", "1")
	old := f.seen(state{Installed: true})
	if err := New(f.opts()).SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	env["DEMO_CLI_TELEMETRY"] = "1"
	c := New(f.opts())
	if c.ShowNotice(io.Discard) {
		t.Fatal("the notice was seen already, before off")
	}
	c.Started()
	hits := f.hits()
	equal(t, "events", len(hits), 2)
	id := hits[0].body["distinct_id"].(string)
	if id == old || !uuidV4.MatchString(id) || string(f.state().ID) != id {
		t.Fatalf("id %q, old %q, state %+v", id, old, f.state())
	}
}

func TestDisabledTouchesNothing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		env     []string
		version string
	}{
		{"DO_NOT_TRACK", []string{"DO_NOT_TRACK", "1"}, "1.2.3"},
		{"PREFIX=off", []string{"DEMO_CLI_TELEMETRY", "off"}, "1.2.3"},
		{"CI", []string{"CI", "true"}, "1.2.3"},
		{"dev build", nil, "0.0.0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t, tc.env...)
			tty = true
			o := f.opts()
			o.Version = tc.version
			c := New(o)
			if c.ShowNotice(io.Discard) {
				t.Fatal("notice shown while off")
			}
			c.MarkNoticeSeen()
			c.Started()
			c.Feature("sync")
			c.Error(errors.New("boom"))
			Capture("page_viewed", nil, "", o)
			equal(t, "events", f.events(), []string(nil))
			if _, err := os.Stat(f.dir); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("state directory written while off: %v", err)
			}
		})
	}

	t.Run("enabled false", func(t *testing.T) {
		f := setup(t)
		f.seen(state{Enabled: new(bool), Installed: true})
		before, _ := os.ReadFile(f.path())
		c := New(f.opts())
		c.MarkNoticeSeen()
		c.Started()
		c.Feature("sync")
		equal(t, "events", f.events(), []string(nil))
		after, _ := os.ReadFile(f.path())
		equal(t, "state file", string(after), string(before))
	})
}

func TestUnwritableStateDirSendsNothing(t *testing.T) {
	f := setup(t)
	tty = true
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	o := f.opts()
	o.StateDir = filepath.Join(blocker, "state")
	var out bytes.Buffer
	c := New(o)
	if c.ShowNotice(&out) || out.Len() > 0 {
		t.Fatal("notice shown though it cannot be recorded")
	}
	c.Started()
	equal(t, "events", f.events(), []string(nil))

	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return // a read-only directory does not stop these
	}
	f.seen(state{}) // app_installed is due, and recording it fails
	if err := os.Chmod(f.dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(f.dir, 0o700) }()
	New(f.opts()).Started()
	equal(t, "events with a read-only state directory", f.events(), []string(nil))
}

func TestAppInstalledOnce(t *testing.T) {
	f := setup(t)
	f.seen(state{})
	c := New(f.opts())
	c.Feature("sync") // the first event of any kind brings app_installed
	equal(t, "first event", f.events(), []string{"app_installed", "feature_used"})
	c.Started()
	equal(t, "same run", f.events(), []string{"app_started"})
	New(f.opts()).Started()
	equal(t, "next run", f.events(), []string{"app_started"})
	if !f.state().Installed {
		t.Fatal("installed not recorded")
	}
}

func TestDailyThrottle(t *testing.T) {
	for _, mode := range []string{"scheduled", "daemon", "plugin"} {
		t.Run(mode, func(t *testing.T) {
			f := setup(t)
			f.seen(state{Installed: true})
			o := f.opts()
			o.Mode = mode
			for range 2 {
				c := New(o)
				c.Started()
				c.Feature("sync")
				c.Feature("sync")
				c.Feature("chats list")
				c.Error(TypeOnly("FloodWait"))
				c.Error(TypeOnly("FloodWait"))
			}
			equal(t, "first day", f.events(), []string{"app_started", "error_occurred", "feature_used", "feature_used"})
			day := "2026-10-28"
			equal(t, "daily", f.state().Daily, map[string]string{
				"app_started": day, "feature_used:sync": day, "feature_used:chats list": day, "error_occurred:FloodWait": day,
			})

			clock = clock.Add(24 * time.Hour)
			New(o).Started()
			equal(t, "next day", f.events(), []string{"app_started"})
			equal(t, "daily keeps only today", f.state().Daily, map[string]string{"app_started": "2026-10-29"})
		})
	}

	t.Run("script", func(t *testing.T) {
		f := setup(t)
		f.seen(state{Installed: true})
		New(f.opts()).Started()
		New(f.opts()).Started()
		equal(t, "events", f.events(), []string{"app_started", "app_started"})
		equal(t, "daily", f.state().Daily, map[string]string{})
	})
}

func TestFeatureAllowlist(t *testing.T) {
	f := setup(t)
	f.seen(state{Installed: true})
	c := New(f.opts())
	for _, name := range []string{"chats list", "chats list --chat Family", "Sync", ""} {
		c.Feature(name)
	}
	var got []string
	for _, h := range f.hits() {
		got = append(got, h.body["properties"].(map[string]any)["feature"].(string))
	}
	slices.Sort(got)
	equal(t, "features", got, []string{"chats list", "other", "other", "other"})
}

type quotaError struct{}

func (quotaError) Error() string { return "quota exceeded" }

func TestErrors(t *testing.T) {
	home := filepath.Join(t.TempDir(), "ann")
	setup(t, "HOME", home, "USER", "ann")

	equal(t, "home and user", scrub(fmt.Sprintf("open %s/notes.txt: not allowed for ann", home)), "open ~/notes.txt: not allowed for <user>")
	for _, tc := range []struct{ home, user, in, want string }{
		{"/Users/Ann", "ann", "read /users/ann/x and /Users/annabel/y as ANN", "read ~/x and /Users/annabel/y as <user>"},
		{`C:\Users\ann`, "ann", `C:\Users\Ann\a and C:/Users/ann/b`, `~\a and ~/b`},
		{"/home/user", "user", "user wrote to /home/user/z", "<user> wrote to ~/z"},
		{"/home/annexample", "ann", "ann and annexample annotate", "<user> and <user> annotate"},
		{"/", "a", " a / b ", "a / b"},
	} {
		env["HOME"], env["USER"] = tc.home, tc.user
		equal(t, tc.in, scrub(tc.in), tc.want)
	}
	env["HOME"], env["USER"] = home, "ann"
	equal(t, "trailing slash in HOME", func() string {
		env["HOME"] = home + "/"
		defer func() { env["HOME"] = home }()
		return scrub(home + "/x")
	}(), "~/x")
	equal(t, "spaces", scrub("  padded \n"), "padded")
	equal(t, "cut to 300 characters", scrub(strings.Repeat("é", 400)), strings.Repeat("é", 300))

	f := setup(t, "HOME", home, "USER", "ann")
	f.seen(state{Installed: true})
	c := New(f.opts())
	for _, tc := range []struct {
		err       error
		typ, msg  string
		noMessage bool
	}{
		{err: &fs.PathError{Op: "open", Path: home + "/x.json", Err: fs.ErrPermission}, typ: "EACCES", msg: "open ~/x.json: permission denied"},
		{err: fmt.Errorf("load config: %w", os.ErrNotExist), typ: "ENOENT", msg: "load config: file does not exist"},
		{err: fmt.Errorf("fetch: %w", context.DeadlineExceeded), typ: "ETIMEDOUT", msg: "fetch: context deadline exceeded"},
		{err: errors.New("boom"), typ: "error", msg: "boom"},
		{err: fmt.Errorf("probe: %w", quotaError{}), typ: "telemetry.quotaError", msg: "probe: quota exceeded"},
		{err: fmt.Errorf("sync chat %q: %w", "Family", TypeOnly("FloodWait")), typ: "FloodWait", noMessage: true},
	} {
		c.Error(tc.err)
		hits := f.hits()
		if len(hits) != 1 {
			t.Fatalf("%v: %d requests", tc.err, len(hits))
		}
		p := hits[0].body["properties"].(map[string]any)
		equal(t, tc.typ+" type", p["error_type"], any(tc.typ))
		if msg, ok := p["error_message"]; tc.noMessage {
			if ok {
				t.Errorf("%s: message sent: %q", tc.typ, msg)
			}
		} else {
			equal(t, tc.typ+" message", msg, any(tc.msg))
		}
	}
	c.Error(nil)
	equal(t, "nil error", f.events(), []string(nil))
}

func TestStateFile(t *testing.T) {
	f := setup(t)
	tty = true
	c := New(f.opts())
	c.ShowNotice(io.Discard)
	var raw map[string]any
	b, _ := os.ReadFile(f.path())
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	id := string(f.state().ID)
	equal(t, "file", raw, map[string]any{"id": id, "enabled": nil, "notice": 1.0, "installed": false, "daily": map[string]any{}})
	// The same bytes the TypeScript and Python clients write.
	equal(t, "bytes", string(b), `{"id":"`+id+`","enabled":null,"notice":1,"installed":false,"daily":{}}`+"\n")
	entries, _ := os.ReadDir(f.dir)
	if len(entries) != 1 || entries[0].Name() != "telemetry.json" {
		t.Fatalf("state directory holds %v", entries)
	}

	// A reader holding the old file still sees it whole: the new one is renamed into place.
	var old *os.File
	if runtime.GOOS != "windows" { // Windows cannot replace a file that is open
		var err error
		if old, err = os.Open(f.path()); err != nil {
			t.Fatal(err)
		}
		defer old.Close()
	}
	if err := c.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	if old != nil {
		kept, _ := io.ReadAll(old)
		equal(t, "old file", string(kept), string(b))
	}
	b, _ = os.ReadFile(f.path())
	raw = nil
	_ = json.Unmarshal(b, &raw)
	equal(t, "after off", raw, map[string]any{"id": nil, "enabled": false, "notice": 1.0, "installed": false, "daily": map[string]any{}})
	equal(t, "status after off", c.Status(), Status{Reason: "state", StateFile: f.path(), Endpoint: f.url})
	js, _ := json.Marshal(c.Status())
	raw = nil
	_ = json.Unmarshal(js, &raw)
	equal(t, "status JSON", raw, map[string]any{"enabled": false, "debug": false, "reason": "state", "id": nil, "stateFile": f.path(), "endpoint": f.url})

	if err := c.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	st := f.state()
	if st.Enabled == nil || !*st.Enabled || st.Notice != NoticeVersion || !uuidV4.MatchString(string(st.ID)) || string(st.ID) == id {
		t.Fatalf("after on: %+v", st)
	}
	equal(t, "status after on", c.Status(), Status{Enabled: true, Reason: "state", ID: string(st.ID), StateFile: f.path(), Endpoint: f.url})
	on := New(f.opts()) // c showed the notice, so it stays quiet
	if err := on.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	on.Started() // an explicit opt-in is not a notice run
	equal(t, "events after on", f.events(), []string{"app_installed", "app_started"})
	entries, _ = os.ReadDir(f.dir)
	equal(t, "no temp files left", len(entries), 1)

	o := f.opts()
	o.StateDir = ""
	if err := New(o).SetEnabled(false); err == nil {
		t.Fatal("SetEnabled without a state directory reported no error")
	}
}

func TestOffFromAnotherProcessStopsADaemon(t *testing.T) {
	f := setup(t)
	f.seen(state{Installed: true})
	o := f.opts()
	o.Mode = "daemon"
	daemon := New(o)
	daemon.Started()
	equal(t, "before off", f.events(), []string{"app_started"})
	if err := New(f.opts()).SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	daemon.Feature("sync")
	equal(t, "after off", f.events(), []string(nil))
	if st := f.state(); st.ID != "" || len(st.Daily) > 0 {
		t.Fatalf("the daemon wrote its state back: %+v", st)
	}
	if err := New(f.opts()).SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	daemon.Feature("sync")
	equal(t, "after on", f.events(), []string{"app_installed", "feature_used"})
}

func TestAgentAndMode(t *testing.T) {
	for _, tc := range []struct {
		env  []string
		want string
	}{
		{nil, ""},
		{[]string{"AI_AGENT", "Amp"}, "amp"},
		{[]string{"AI_AGENT", "claude-code_2.1"}, "claude-code"},
		{[]string{"AI_AGENT", "Goose_cli", "CLAUDECODE", "1"}, "goose"},
		{[]string{"AI_AGENT", strings.Repeat("x", 60)}, strings.Repeat("x", 40)},
		{[]string{"CLAUDECODE", "1"}, "claude-code"},
		{[]string{"CLAUDECODE", "1", "GEMINI_CLI", "1"}, "claude-code"},
		{[]string{"CODEX_SANDBOX", "seatbelt"}, "codex"},
		{[]string{"CODEX_THREAD_ID", "t-1"}, "codex"},
		{[]string{"CURSOR_AGENT", "1"}, "cursor"},
		{[]string{"GEMINI_CLI", "1"}, "gemini"},
	} {
		setup(t, tc.env...)
		equal(t, fmt.Sprint(tc.env), detectAgent(), tc.want)
	}

	for _, tc := range []struct {
		mode  string
		agent bool
		tty   bool
		want  string
	}{
		{"scheduled", true, true, "scheduled"},
		{"server", false, false, "server"},
		{"", true, true, "agent"},
		{"", false, true, "interactive"},
		{"", false, false, "script"},
	} {
		setup(t)
		if tc.agent {
			env["CURSOR_AGENT"] = "1"
		}
		tty = tc.tty
		equal(t, fmt.Sprint(tc), defaults(Options{Mode: tc.mode}).Mode, tc.want)
	}

	null, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	if terminal(null) {
		t.Error("the null device counts as a terminal")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	if terminal(r) {
		t.Error("a pipe counts as a terminal")
	}
}

func TestBody(t *testing.T) {
	f := setup(t, "CLAUDECODE", "1")
	id := f.seen(state{Installed: true})
	New(f.opts()).Feature("chats list")
	hits := f.hits()
	if len(hits) != 1 {
		t.Fatalf("%d requests", len(hits))
	}
	h := hits[0]
	equal(t, "request", []string{h.method, h.path, h.header.Get("Content-Type"), h.header.Get("User-Agent")},
		[]string{"POST", "/i/v0/e/", "application/json", "devkit-telemetry/1 (demo-cli/1.2.3)"})
	equal(t, "project key", projectKey, "phc_np7sxHvzFH1HDTlQdMaqRDrpOVZ0xytnSDxyCMBwNO9") // the public, write-only key. gitleaks:allow
	prefix := `{"api_key":"` + projectKey + `","event":"feature_used","distinct_id":"` + id + `","timestamp":"2026-10-28T09:12:03.123Z","properties":{`
	if !strings.HasPrefix(string(h.raw), prefix) {
		t.Errorf("body starts %q", h.raw)
	}
	props := map[string]any{
		"$process_person_profile": false,
		"$lib":                    "devkit-telemetry",
		"$lib_version":            "1",
		"product":                 "demo-cli",
		"$app_version":            "1.2.3",
		"$os":                     map[string]string{"darwin": "macOS", "linux": "Linux", "windows": "Windows"}[runtime.GOOS],
		"arch":                    map[string]string{"arm64": "arm64", "amd64": "x64"}[runtime.GOARCH],
		"runtime":                 "go " + strings.TrimPrefix(runtime.Version(), "go"),
		"channel":                 "binary",
		"mode":                    "agent",
		"agent":                   "claude-code",
		"feature":                 "chats list",
	}
	if v := osVersion(); v != "" {
		props["$os_version"] = v
	}
	equal(t, "body", h.body, map[string]any{
		"api_key":     projectKey,
		"event":       "feature_used",
		"distinct_id": id,
		"timestamp":   "2026-10-28T09:12:03.123Z",
		"properties":  props,
	})
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		if !regexp.MustCompile(`^\d+(\.\d+)*`).MatchString(osVersion()) {
			t.Errorf("os version %q", osVersion())
		}
	}
}

func TestDebugPrintsInsteadOfSending(t *testing.T) {
	f := setup(t, "DEMO_CLI_TELEMETRY", "debug", "CI", "true", "USER", "ann")
	f.seen(state{})
	c := New(f.opts())
	equal(t, "status", c.Status(), Status{Enabled: true, Debug: true, Reason: "env", ID: c.Status().ID, StateFile: f.path(), Endpoint: f.url})
	c.Started()
	c.Error(errors.New("not allowed for ann"))
	equal(t, "sent", f.events(), []string(nil))
	lines := strings.Split(strings.TrimSpace(debugOut.String()), "\n")
	var events []string
	for _, line := range lines {
		body, ok := strings.CutPrefix(line, "[telemetry] ")
		var ev map[string]any
		if !ok || json.Unmarshal([]byte(body), &ev) != nil {
			t.Fatalf("debug line %q", line)
		}
		events = append(events, ev["event"].(string))
	}
	equal(t, "printed", events, []string{"app_installed", "app_started", "error_occurred"})
	if !strings.Contains(debugOut.String(), `"error_message":"not allowed for <user>"`) {
		t.Errorf("debug output: %s", debugOut.String())
	}
}

func TestCapture(t *testing.T) {
	f := setup(t)
	o := Options{Product: "demo-web", Version: "2.0.0", Mode: "server", Endpoint: f.url}
	Capture("page_viewed", map[string]any{"page": "home"}, "visitor-1", o)
	hits := f.hits()
	if len(hits) != 1 {
		t.Fatalf("%d requests", len(hits))
	}
	p := hits[0].body["properties"].(map[string]any)
	equal(t, "capture", []any{hits[0].body["event"], hits[0].body["distinct_id"], p["product"], p["mode"], p["page"]},
		[]any{"page_viewed", "visitor-1", "demo-web", "server", "home"})

	Capture("page_viewed", nil, "", o)
	if hits = f.hits(); len(hits) != 1 || !uuidV4.MatchString(hits[0].body["distinct_id"].(string)) {
		t.Fatalf("random id: %+v", hits)
	}

	env["DO_NOT_TRACK"] = "1"
	Capture("page_viewed", nil, "visitor-1", o)
	equal(t, "with DO_NOT_TRACK", f.events(), []string(nil))
}

func TestFlushWaitsOnlyForInFlight(t *testing.T) {
	setup(t)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	t.Cleanup(srv.Close)
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock) // runs before srv.Close, which waits for open requests

	start := time.Now()
	Flush(time.Second)
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Errorf("Flush with nothing in flight took %v", d)
	}

	Capture("page_viewed", nil, "visitor-1", Options{Product: "demo-web", Version: "2.0.0", Endpoint: srv.URL})
	start = time.Now()
	Flush(100 * time.Millisecond)
	if d := time.Since(start); d < 100*time.Millisecond || d > time.Second {
		t.Errorf("Flush(100ms) with a hung request took %v", d)
	}
	unblock()
	start = time.Now()
	Flush(2 * time.Second)
	if d := time.Since(start); d > time.Second {
		t.Errorf("Flush after the request ended took %v", d)
	}
}

func TestNeverFails(t *testing.T) {
	setup(t)
	var nilClient *Client
	if nilClient.ShowNotice(io.Discard) {
		t.Error("a nil client showed the notice")
	}
	nilClient.MarkNoticeSeen()
	nilClient.Started()
	nilClient.Feature("sync")
	nilClient.Error(errors.New("boom"))
	nilClient.Flush(0)
	equal(t, "nil status", nilClient.Status(), Status{})
	if nilClient.SetEnabled(true) == nil {
		t.Error("SetEnabled on a nil client reported no error")
	}

	c := New(Options{})
	if c == nil {
		t.Fatal("New returned nil")
	}
	equal(t, "empty options", c.Status().Reason, "dev-version")

	f := setup(t)
	tty = true
	if err := os.MkdirAll(f.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.path(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !New(f.opts()).ShowNotice(io.Discard) || !uuidV4.MatchString(string(f.state().ID)) {
		t.Fatal("a broken state file was not replaced")
	}
}
