'use client'

import { useEffect, useState } from 'react'
import { Link } from 'waku'
import { CredentialsForm } from '../components/config/CredentialsForm'
import type { SharedCredentials } from '../types/shared-credentials'

// Import server actions
import { getSharedCredentialsAction, saveSharedCredentialsAction } from '../actions'

export default function CredentialsPage() {
    const [credentials, setCredentials] = useState<Partial<SharedCredentials> | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        loadCredentials()
    }, [])

    const loadCredentials = async () => {
        setIsLoading(true)
        setError(null)

        try {
            const result = await getSharedCredentialsAction()

            if (result.success && result.credentials) {
                setCredentials(result.credentials)
            } else {
                setError(result.error || 'Failed to load credentials')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    const handleSave = async (newCredentials: SharedCredentials) => {
        const result = await saveSharedCredentialsAction(newCredentials)

        if (result.success) {
            setCredentials(newCredentials)
        }

        return result
    }

    return (
        <div className="credentials-page">
            <div className="page-header">
                <div>
                    <h1>API Credentials & Settings</h1>
                    <p className="subtitle">
                        Manage API credentials shared by task-based configurations
                    </p>
                </div>
                <Link to="/" className="btn-back">
                    ← Back to Home
                </Link>
            </div>

            <div className="info-banner">
                <strong>ℹ️ Shared Configuration:</strong> These credentials are used by the task-based configuration system.
                Updates here will be reflected in your main configuration.
            </div>

            {isLoading && (
                <div className="loading">
                    <div className="spinner"></div>
                    Loading credentials...
                </div>
            )}

            {error && !isLoading && (
                <div className="error-message">
                    <strong>Error:</strong> {error}
                </div>
            )}

            {!isLoading && !error && credentials && <CredentialsForm initialCredentials={credentials} onSave={handleSave} />}

            <style jsx>{`
                .credentials-page {
                    max-width: 900px;
                    margin: 0 auto;
                    padding: 2rem;
                }

                .page-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: start;
                    margin-bottom: 2rem;
                    padding-bottom: 1rem;
                    border-bottom: 2px solid #e5e7eb;
                }

                .page-header h1 {
                    margin: 0 0 0.5rem 0;
                    font-size: 2rem;
                    font-weight: 700;
                    color: #111827;
                }

                .subtitle {
                    margin: 0;
                    font-size: 1rem;
                    color: #6b7280;
                }

                .btn-back {
                    padding: 0.5rem 1rem;
                    background: #f3f4f6;
                    color: #374151;
                    text-decoration: none;
                    border-radius: 6px;
                    font-size: 0.875rem;
                    font-weight: 500;
                    transition: background 0.2s;
                }

                .btn-back:hover {
                    background: #e5e7eb;
                }

                .info-banner {
                    padding: 1rem;
                    margin-bottom: 2rem;
                    background: #dbeafe;
                    border: 1px solid #93c5fd;
                    border-radius: 6px;
                    color: #1e40af;
                    font-size: 0.875rem;
                }

                .loading {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    padding: 2rem;
                    text-align: center;
                    color: #6b7280;
                }

                .spinner {
                    width: 20px;
                    height: 20px;
                    border: 3px solid #e5e7eb;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                }

                @keyframes spin {
                    to {
                        transform: rotate(360deg);
                    }
                }

                .error-message {
                    padding: 1rem;
                    background: #fee2e2;
                    border: 1px solid #fecaca;
                    border-radius: 6px;
                    color: #991b1b;
                    font-size: 0.875rem;
                }
            `}</style>
        </div>
    )
}
