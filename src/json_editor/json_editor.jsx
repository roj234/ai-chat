import {appendChildren} from 'unconscious';
import {App} from './App.jsx';
import './json_editor.css';
import {callOnLoadHandler} from "../plugin.js";

const app = document.body;
app.replaceChildren();
appendChildren(app, <App />);
callOnLoadHandler(app);