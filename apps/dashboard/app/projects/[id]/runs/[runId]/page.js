'use client';
import {useEffect, useState} from 'react';
import {useParams} from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const stages = [
    {key: 'planner', label: 'Plan'},
    {key: 'human_approval', label: 'Approval'},
    {key: 'coder', label: 'Code'},
    {key: 'runner', label: 'Execute'},
    {key: 'reviewer', label: 'Review'},
    {key: 'fixer', label: 'Fix'},
    {key: 'git', label: 'Git'},
    {key: 'report', label: 'Report'}
];
const retryable = ['planner', 'coder', 'runner', 'reviewer', 'fixer', 'git', 'report'];

function toastKind(type = '') {
    if (type.includes('FAILED') || type.includes('ERROR')) return 'error';
    if (type.includes('COMPLETED') || type.includes('READY') || type.includes('APPROVED') || type.includes('PASSED')) return 'success';
    return 'info';
}

function formatTehranTime(value) {
    if (!value) return 'زمان نامشخص';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('fa-IR', {
        timeZone: 'Asia/Tehran',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
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
    const [liveConnected, setLiveConnected] = useState(false);

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

        es.onopen = () => setLiveConnected(true);

        es.onmessage = event => {
            try {
                const item = JSON.parse(event.data);

                setEvents(current => {
                    const duplicate = current.some(existing =>
                        existing.id && item.id
                            ? String(existing.id) === String(item.id)
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
            setLiveConnected(false);
        };

        return () => {
            setLiveConnected(false);
            es.close();
        };
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

    const currentRetryAction =
        (run.status === 'waiting_retry' || run.status === 'failed') &&
        retryable.includes(run.current_stage)
            ? run.current_stage
            : null;

    const sortedEvents = [...events].sort((left, right) => {
        const leftTime = new Date(left.created_at || left.ts || 0).getTime();
        const rightTime = new Date(right.created_at || right.ts || 0).getTime();
        return rightTime - leftTime;
    });

    const completedActions = new Set(
        (run.actions || [])
            .filter(action => action.status === 'succeeded')
            .map(action => action.action)
    );
    const humanApproved = events.some(event => event.type === 'HUMAN_APPROVED');

    function stageState(stage) {
        const terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status);
        if (stage === run.current_stage) {
            if (run.status === 'succeeded') return 'complete';
            if (run.status === 'failed' || run.status === 'waiting_retry' || run.status === 'cancelled') return 'failed';
            return 'active';
        }
        if (stage === 'human_approval') return humanApproved ? 'complete' : 'pending';
        if (stage === 'report' && terminal) return 'complete';
        return completedActions.has(stage) ? 'complete' : 'pending';
    }

    return (
        <main className="wrap">
            <a href={`/projects/${run.project_id}`} className="muted">← {run.project_name}</a>

            <div className="top">
                <div className="runTitle">
                    <h1>Run {run.id.slice(0, 8)}</h1>
                    <div className="muted requestText">{run.request}</div>
                </div>

                <div className="runControls">
                    <span className={`liveBadge ${liveConnected ? 'connected' : ''}`}>
                        <span className="liveDot" />
                        {liveConnected ? 'Live' : 'Connecting'}
                    </span>
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

            <div className="stepper" aria-label="Run progress">
                {stages.map((stage, index) => {
                    const state = stageState(stage.key);
                    const nextState = index < stages.length - 1 ? stageState(stages[index + 1].key) : 'pending';
                    return (
                        <div className={`step ${state}`} key={stage.key}>
                            <div className="stepTrack">
                                <span className="stepDot">
                                    {state === 'complete' ? '✓' : state === 'failed' ? '!' : ''}
                                </span>
                                {index < stages.length - 1 && (
                                    <span className={`stepLine ${state === 'complete' ? 'complete' : ''} ${state === 'active' || nextState === 'active' ? 'moving' : ''}`} />
                                )}
                            </div>
                            <span className="stepLabel">{stage.label}</span>
                        </div>
                    );
                })}
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

            <div className="card eventsCard">
                <div className="eventsTitle">
                    <h3>Live events</h3>
                    <span className="muted">Newest first</span>
                </div>
                <div className="logs">
                    {sortedEvents.map((event, index) => (
                        <div
                            className={`log ${toastKind(event.type)}`}
                            key={event.id || `${event.type}-${event.created_at || event.ts}-${index}`}
                        >
                            <div className="logHeader">
                                <b className="logType">{event.type}</b>
                                <time className="logTime" dateTime={event.created_at || event.ts}>
                                    {formatTehranTime(event.created_at || event.ts)} تهران
                                </time>
                            </div>
                            <div className="logMessage">{event.message}</div>
                        </div>
                    ))}
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

                .runControls {
                    display: flex;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 10px;
                    flex-wrap: wrap;
                }

                .liveBadge {
                    display: inline-flex;
                    align-items: center;
                    gap: 7px;
                    padding: 5px 10px;
                    border: 1px solid #344264;
                    border-radius: 999px;
                    color: #94a3b8;
                    font-size: 12px;
                }

                .liveDot {
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: #64748b;
                }

                .liveBadge.connected {
                    color: #86efac;
                    border-color: rgba(34, 197, 94, 0.35);
                    background: rgba(22, 101, 52, 0.14);
                }

                .liveBadge.connected .liveDot {
                    background: #22c55e;
                    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12);
                }

                .stepper {
                    display: grid;
                    grid-template-columns: repeat(${stages.length}, minmax(72px, 1fr));
                    margin: 24px 0;
                    padding: 20px 18px 16px;
                    border: 1px solid #25304e;
                    border-radius: 16px;
                    background: linear-gradient(180deg, rgba(24, 32, 57, 0.9), rgba(17, 24, 45, 0.9));
                    overflow-x: auto;
                }

                .step {
                    min-width: 72px;
                    text-align: center;
                }

                .stepTrack {
                    display: flex;
                    align-items: center;
                }

                .stepDot {
                    position: relative;
                    z-index: 2;
                    display: grid;
                    place-items: center;
                    flex: 0 0 24px;
                    width: 24px;
                    height: 24px;
                    border: 2px solid #64748b;
                    border-radius: 50%;
                    background: #11182d;
                    color: white;
                    font-size: 13px;
                    font-weight: 800;
                }

                .stepLine {
                    position: relative;
                    height: 3px;
                    flex: 1;
                    background: #334155;
                    overflow: hidden;
                }

                .step.complete .stepDot {
                    border-color: #22c55e;
                    background: #16a34a;
                    box-shadow: 0 0 0 5px rgba(34, 197, 94, 0.1);
                }

                .stepLine.complete {
                    background: #22c55e;
                }

                .step.active .stepDot {
                    border-color: #60a5fa;
                    box-shadow: 0 0 0 5px rgba(59, 130, 246, 0.14);
                    animation: pulseStep 1.6s ease-in-out infinite;
                }

                .stepLine.moving::after {
                    content: '';
                    position: absolute;
                    inset: 0;
                    width: 42%;
                    background: linear-gradient(90deg, transparent, #60a5fa, transparent);
                    animation: moveProgress 1.4s linear infinite;
                }

                .step.failed .stepDot {
                    border-color: #ef4444;
                    background: #991b1b;
                }

                .stepLabel {
                    display: block;
                    margin-top: 9px;
                    margin-left: -36px;
                    color: #94a3b8;
                    font-size: 12px;
                    font-weight: 650;
                }

                .step.complete .stepLabel,
                .step.active .stepLabel {
                    color: #e5edff;
                }

                .eventsTitle {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                }

                .eventsTitle h3 {
                    margin: 0 0 14px;
                }

                .eventsCard {
                    margin-top: 16px;
                }

                @keyframes pulseStep {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.08); }
                }

                @keyframes moveProgress {
                    from { transform: translateX(-120%); }
                    to { transform: translateX(260%); }
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

                .planViewer pre {
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

                .logs {
                    display: grid;
                    align-content: start;
                    gap: 10px;
                    padding: 12px;
                }

                .log {
                    padding: 11px 12px;
                    border: 1px solid #273451;
                    border-left: 4px solid #3b82f6;
                    border-radius: 10px;
                    background: #10182a;
                }

                .log.success {
                    border-left-color: #22c55e;
                    background: rgba(22, 101, 52, 0.16);
                }

                .log.error {
                    border-left-color: #ef4444;
                    background: rgba(153, 27, 27, 0.18);
                }

                .logHeader {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    margin-bottom: 7px;
                }

                .logType {
                    color: #e5edff;
                    font-size: 12px;
                    letter-spacing: 0.02em;
                }

                .logTime {
                    color: #91a0bd;
                    font-size: 11px;
                    white-space: nowrap;
                }

                .logMessage {
                    color: #cbd5e1;
                    line-height: 1.55;
                    overflow-wrap: anywhere;
                }

                @media (max-width: 720px) {
                    .stepper {
                        grid-template-columns: repeat(${stages.length}, 84px);
                    }

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
