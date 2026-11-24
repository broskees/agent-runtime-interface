package ari

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MemoryHost keeps everything in memory: each instance's config (WithConfig), secrets,
// coordination leases and the diagnostics the driver logs. Background work may always run; no
// attachments resolve. The other host services refuse with unsupported.
type MemoryHost struct {
	UnsupportedHost

	mu          sync.Mutex
	configs     map[string]any
	secrets     map[[3]string]SecretValue
	leases      map[string]memoryLease
	nextLease   int
	diagnostics []HostDiagnosticsLogParams
}

type memoryLease struct {
	key   string
	until time.Time
}

func NewMemoryHost() *MemoryHost {
	return &MemoryHost{configs: map[string]any{}, secrets: map[[3]string]SecretValue{}, leases: map[string]memoryLease{}}
}

// WithConfig sets the config host/config.get answers for instanceID, the id the host gives driver/create.
func (h *MemoryHost) WithConfig(instanceID string, config any) *MemoryHost {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.configs[instanceID] = config
	return h
}

// Diagnostics is every diagnostic the driver logged, in order.
func (h *MemoryHost) Diagnostics() []HostDiagnosticsLogParams {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]HostDiagnosticsLogParams(nil), h.diagnostics...)
}

func (h *MemoryHost) ConfigGet(ctx context.Context, params HostConfigGetParams) (HostConfigGetResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	config, found := h.configs[params.InstanceID]
	if !found {
		resource, id := "instance", params.InstanceID
		return HostConfigGetResult{}, &Error{CallError{&NotFoundError{Message: "no config for instance " + params.InstanceID, Resource: &resource, ID: &id}}}
	}
	return HostConfigGetResult{Config: config}, nil
}

func (h *MemoryHost) SecretsGet(ctx context.Context, params HostSecretParams) (NullableSecretValue, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	value, found := h.secrets[[3]string{params.InstanceID, params.Namespace, params.Key}]
	if !found {
		return nil, nil
	}
	return &value, nil
}

func (h *MemoryHost) SecretsSet(ctx context.Context, params HostSecretsSetParams) (VoidResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.secrets[[3]string{params.InstanceID, params.Namespace, params.Key}] = params.Value
	return VoidResult{}, nil
}

func (h *MemoryHost) SecretsDelete(ctx context.Context, params HostSecretParams) (VoidResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.secrets, [3]string{params.InstanceID, params.Namespace, params.Key})
	return VoidResult{}, nil
}

func (h *MemoryHost) AttachmentsResolve(ctx context.Context, params HostAttachmentParams) (NullableAttachmentInfo, error) {
	return nil, nil
}

func (h *MemoryHost) BackgroundShouldRun(ctx context.Context, params HostBackgroundShouldRunParams) (BooleanResult, error) {
	return true, nil
}

func (h *MemoryHost) CoordinationAcquire(ctx context.Context, params HostCoordinationAcquireParams) (NullableLease, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	for _, lease := range h.leases {
		if lease.key == params.Key && lease.until.After(now) {
			return nil, nil
		}
	}
	h.nextLease++
	leaseID := fmt.Sprintf("lease-%d", h.nextLease)
	until := now.Add(time.Duration(max(params.TtlMs, 1)) * time.Millisecond)
	h.leases[leaseID] = memoryLease{key: params.Key, until: until}
	return &Lease{LeaseID: leaseID, Key: params.Key, ExpiresAt: until.UTC().Format("2006-01-02T15:04:05.000Z")}, nil
}

func (h *MemoryHost) CoordinationRelease(ctx context.Context, params HostCoordinationReleaseParams) (VoidResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.leases, params.LeaseID)
	return VoidResult{}, nil
}

func (h *MemoryHost) DiagnosticsLog(ctx context.Context, params HostDiagnosticsLogParams) (VoidResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.diagnostics = append(h.diagnostics, params)
	return VoidResult{}, nil
}
