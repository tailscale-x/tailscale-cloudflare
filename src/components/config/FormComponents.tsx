'use client';

import { useState, type FormEvent, type ChangeEvent } from 'react';

interface FormInputProps {
    label: string;
    name: string;
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
    type?: 'text' | 'password';
    required?: boolean;
    placeholder?: string;
    helpText?: React.ReactNode;
}

export function FormInput({
    label,
    name,
    value,
    onChange,
    type = 'text',
    required = false,
    placeholder,
    helpText,
}: FormInputProps) {
    return (
        <div className="form-group">
            <label htmlFor={name}>
                {label}
                {required && <span className="required"> *</span>}
            </label>
            <input
                type={type}
                id={name}
                name={name}
                value={value}
                onChange={onChange}
                required={required}
                placeholder={placeholder}
            />
            {helpText && <small>{helpText}</small>}
        </div>
    );
}

interface FormSectionProps {
    title: string;
    description?: string;
    children: React.ReactNode;
}

export function FormSection({ title, description, children }: FormSectionProps) {
    return (
        <>
            <h2>{title}</h2>
            {description && <p className="section-help">{description}</p>}
            {children}
        </>
    );
}

interface MessageProps {
    type: 'success' | 'error';
    message: string;
}

export function Message({ type, message }: MessageProps) {
    return (
        <div className={`message ${type}`}>
            {message}
        </div>
    );
}
