'use client';
import {useEffect, useState} from 'react';
import {useParams} from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const stages = ['planner', 'human_approval', 'coder', 'runner', 'reviewer', 'fixer', 'git', 'report'];
const retryable = ['planner', 'coder', 'runner', 'reviewer', 'fixer', 'git', 'report'];

function toastKind(type = '') {
    if (type.includes('FAILED') || type.includes('ERROR')) return 'error';
    if (type.includes('COMPLETED') || type.includes('READY') || type.includes('APPROVED') || type.includes('PASSED')) return 'success';
    return 'info';
}

export default function Run() {
    const params = useParams();

    const [run, setRun] = useState(null);
    const [events, setEvents] = useState([]);
    const [feedback, setFeedback] = useState('');
    const [retrying, setRetrying] = useState('');
    const [retryError, setRetryError] = useState('');
    const [approving, setApproving] = useState(false);
    const [toast, setToast] = useState(null);

    function showToast(message, kind = 'info') {
        setToast({message, kind});
    }

    async function load({replaceEvents = true} = {}) {
        const response = await fetch(`${API}/runs/${params.runId}`, {cache: 'no-store'});
        if (!response.ok) throw new Error(`Unable to load run (${response.status})`);

        const data = await response.json();
        setRun(data);

        if (replaceEvents) {
            setEvents(data.events || []);
        }

        return data;
    }

    async function refreshState() {
        try {
            await load({replaceEvents: false});
        } catch (error) {
            console.error('Unable to refresh run state', error);
        }
    }

    useEffect(() => {
        const runId = params.runId;
        if (!runId) return;

        load().catch(error => showToast(error.message, 'error'));

        const es = new EventSource(`${API}/runs/${runId}/events`);

        es.onmessage = event => {
            try {
                const item = JSON.parse(event.data);

                setEvents(current => {
                    const duplicate = current.some(existing =>
                        existing.id && item.id
                            ? existing.id === item.id
                            : existing.type === item.type &&
                              (existing.created_at || existing.ts) === (item.created_at || item.ts)
                    );

                    return duplicate ? current : [...current, item];
                });

                showToast(item.message || item.type, toastKind(item.type));

                // Every backend event can represent a status/current_stage change.
                // Refresh only the Run object and keep the locally appended event list.
                refreshState();
            } catch (error) {
                console.error('Invalid SSE event', error);
            }
        };

        es.onerror = () => {
            showToast('Live connection interrupted. Reconnecting…', 'error');
        };

        return () => es.close();
    }, [params.runId]);

    useEffect(() => {
        if (!toast) return;

        const timer = setTimeout(() => setToast(null), 3500);
        return () => clearTimeout(timer);
    }, [toast]);

    if (!run) return <main className="wrap">Loading...</main>;

    async function approve() {
        if (approving) return;

        setApproving(true);

        try {
            const response = await fetch(`${API}/runs/${run.id}/approve`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({feedback})
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error || `Approval failed (${response.status})`);
            }

            setRun(current => ({
                ...current,
                ...data
            }));
            setFeedback('');
            showToast('Plan approved. Pipeline continued.', 'success');
            await refreshState();
        } catch (error) {
            showToast(error.message, 'error');
        } finally {
            setApproving(false);
        }
    }

    async function retryAction(action) {
        if (retrying) return;

        setRetrying(action);
        setRetryError('');

        try {
            const response = await fetch(`${API}/runs/${run.id}/actions/${action}/retry`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({})
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error || `Retry failed (${response.status})`);
            }

            showToast(`Retry started for ${action}.`, 'info');
            await refreshState();
        } catch (error) {
            setRetryError(`${action}: ${error.message}`);
            showToast(error.message, 'error');
            await refreshState();
        } finally {
            setRetrying('');
        }
    }

    const blocked =
        run.project_status === 'archived' ||
        run.status === 'cancelled' ||
        run.status === 'succeeded';

    const currentRetryAction = retryable.includes(run.current_stage)
        ? run.current_stage
        : null;

    return (
        <main className="wrap">
            <a href={`/projects/${run.project_id}`} className="muted">← {run.project_name}</a>

            <div className="top">
                <div className="runTitle">
                    <h1>Run {run.id.slice(0, 8)}</h1>
                    <div className="muted requestText">{run.request}</div>
                </div>

                <div className="runControls">
                    <span className="status">{run.status}</span>

                    {currentRetryAction && (
                        <button
                            className="btn ghost"
                            disabled={blocked || Boolean(retrying)}
                            onClick={() => retryAction(currentRetryAction)}
                        >
                            {retrying
                                ? `Retrying ${currentRetryAction}...`
                                : `Retry current stage (${currentRetryAction})`}
                        </button>
                    )}
                </div>
            </div>

            <div className="pipeline">
                {stages.map(stage => (
                    <div
                        className={`stage ${stage === run.current_stage ? 'active' : ''}`}
                        key={stage}
                    >
                        {stage}
                    </div>
                ))}
            </div>

            {retryError && <div className="retryError">{retryError}</div>}

            {run.status === 'awaiting_approval' && (
                <div className="card approvalCard">
                    <div className="approvalHeader">
                        <div>
                            <h3>Human approval</h3>
                            <p className="muted approvalHint">
                                Review the generated plan, add optional feedback, then continue the pipeline.
                            </p>
                        </div>
                    </div>

                    <div className="planViewer">
                        <pre>{JSON.stringify(run.plan, null, 2)}</pre>
                    </div>

                    <textarea
                        className="area approvalFeedback"
                        value={feedback}
                        onChange={event => setFeedback(event.target.value)}
                        placeholder="Optional feedback"
                    />

                    <div className="approvalActions">
                        <button
                            className="btn"
                            disabled={approving}
                            onClick={approve}
                        >
                            {approving ? 'Approving...' : 'Approve & Continue'}
                        </button>
                    </div>
                </div>
            )}

            <div className="cols">
                <div className="card">
                    <h3>Live events</h3>
                    <div className="logs">
                        {events.map((event, index) => (
                            <div
                                className="log"
                                key={event.id || `${event.type}-${event.created_at || event.ts}-${index}`}
                            >
                                {event.created_at || event.ts} · <b>{event.type}</b> · {event.message}
                            </div>
                        ))}
                    </div>
                </div>

                <div className="card">
                    <h3>Run state</h3>
                    <pre className="stateViewer">
                        {JSON.stringify({
                            stage: run.current_stage,
                            status: run.status,
                            fixAttempt: run.fix_attempt
                        }, null, 2)}
                    </pre>
                </div>
            </div>

            {toast && (
                <div className={`runToast ${toast.kind}`} role="status">
                    {toast.message}
                </div>
            )}

            <style jsx>{`
                .runTitle {
                    min-width: 0;
                    flex: 1;
                }

                .requestText {
                    overflow-wrap: anywhere;
                    word-break: break-word;
                }

                .approvalCard {
                    min-width: 0;
                    overflow: hidden;
                }

                .approvalHeader {
                    display: flex;
                    justify-content: space-between;
                    gap: 16px;
                    align-items: flex-start;
                    min-width: 0;
                }

                .approvalHint {
                    margin: 4px 0 0;
                    overflow-wrap: anywhere;
                }

                .planViewer {
                    width: 100%;
                    max-width: 100%;
                    max-height: 420px;
                    overflow: auto;
                    box-sizing: border-box;
                    margin: 16px 0;
                    border: 1px solid rgba(127, 127, 127, 0.24);
                    border-radius: 10px;
                }

                .planViewer pre,
                .stateViewer {
                    margin: 0;
                    padding: 16px;
                    box-sizing: border-box;
                    max-width: 100%;
                    white-space: pre-wrap;
                    overflow-wrap: anywhere;
                    word-break: break-word;
                }

                .approvalFeedback {
                    width: 100%;
                    max-width: 100%;
                    box-sizing: border-box;
                    min-height: 100px;
                    resize: vertical;
                }

                .approvalActions {
                    display: flex;
                    justify-content: flex-end;
                    margin-top: 12px;
                }

                .runToast {
                    position: fixed;
                    right: 24px;
                    bottom: 24px;
                    z-index: 1000;
                    max-width: min(420px, calc(100vw - 48px));
                    padding: 12px 16px;
                    border-radius: 10px;
                    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.2);
                    color: white;
                    background: #334155;
                    overflow-wrap: anywhere;
                }

                .runToast.success {
                    background: #166534;
                }

                .runToast.error {
                    background: #991b1b;
                }

                .runToast.info {
                    background: #1e40af;
                }

                @media (max-width: 720px) {
                    .runToast {
                        right: 12px;
                        bottom: 12px;
                        max-width: calc(100vw - 24px);
                    }

                    .approvalActions {
                        justify-content: stretch;
                    }

                    .approvalActions :global(.btn) {
                        width: 100%;
                    }
                }
            `}</style>
        </main>
    );
}
