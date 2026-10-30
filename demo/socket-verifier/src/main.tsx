import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

//* v5 B17: fail with a clear message if index.html lost its mount point.
const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing - main.tsx');

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
