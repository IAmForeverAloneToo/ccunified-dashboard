package payload

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const schemaDir = "../../../schema"

func examples(t *testing.T, kind string) map[string][]byte {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(schemaDir, "examples", kind, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no %s examples found: %v", kind, err)
	}
	out := make(map[string][]byte, len(files))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.Base(f)] = b
	}
	return out
}

func compileSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	s, err := c.Compile(filepath.Join(schemaDir, "ingest.schema.json"))
	if err != nil {
		t.Fatalf("compile schema: %v", err)
	}
	return s
}

func decodeStrict(b []byte) (*Payload, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var p Payload
	if err := dec.Decode(&p); err != nil {
		return nil, err
	}
	return &p, nil
}

func generic(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// Every valid example must decode into our types, pass Validate, survive a
// round trip unchanged, and match the published JSON Schema.
func TestValidExamples(t *testing.T) {
	schema := compileSchema(t)
	for name, b := range examples(t, "valid") {
		t.Run(name, func(t *testing.T) {
			p, err := decodeStrict(b)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if err := p.Validate(); err != nil {
				t.Fatalf("Validate: %v", err)
			}
			out, err := json.Marshal(p)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(generic(t, b), generic(t, out)) {
				t.Fatalf("round trip changed the payload:\n in: %s\nout: %s", b, out)
			}
			if err := schema.Validate(generic(t, out)); err != nil {
				t.Fatalf("JSON Schema rejected our encoding: %v", err)
			}
		})
	}
}

// Every invalid example must be refused before it could be sent.
func TestInvalidExamples(t *testing.T) {
	for name, b := range examples(t, "invalid") {
		t.Run(name, func(t *testing.T) {
			p, err := decodeStrict(b)
			if err != nil {
				return // refused at decode time (unknown field, wrong type)
			}
			if err := p.Validate(); err == nil {
				t.Fatal("Validate accepted an invalid payload")
			}
		})
	}
}

// The published JSON Schema must reject the invalid examples too, except the
// rule-* ones (uniqueness and date-range checks), which JSON Schema cannot express.
func TestSchemaRejectsInvalidExamples(t *testing.T) {
	schema := compileSchema(t)
	for name, b := range examples(t, "invalid") {
		if strings.HasPrefix(name, "rule-") {
			continue
		}
		t.Run(name, func(t *testing.T) {
			if err := schema.Validate(generic(t, b)); err == nil {
				t.Fatal("JSON Schema accepted an invalid payload")
			}
		})
	}
}

func TestNilSlicesAreRejected(t *testing.T) {
	p := Payload{
		SchemaVersion: SchemaVersion,
		Agent:         Agent{Version: "dev", OS: "linux", Arch: "amd64", CcusageVersion: "20.0.31", SyncIntervalMinutes: 30},
		Timezone:      "UTC",
		Range:         Range{From: "2026-10-01", To: "2026-10-07"},
	}
	if err := p.Validate(); err == nil || !strings.Contains(err.Error(), "days") {
		t.Fatalf("want error about days, got %v", err)
	}
}
