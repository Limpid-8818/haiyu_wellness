import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { Root } from './app/Root.jsx';
import { ErrorBoundary } from './shared/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(<ErrorBoundary><Root/></ErrorBoundary>);
