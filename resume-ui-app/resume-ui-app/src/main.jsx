import React from "react";
import ReactDOM from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  Navigate
} from "react-router-dom";
import Landing from "./Landing.jsx";   // 👈 ADD THIS
import App from "./App.jsx";
import Viewer from "./Viewer.jsx";
import "./index.css";

const router = createBrowserRouter([
  { path: "/", element: <Landing /> },                 // 👈 Landing at root
  { path: "/app", element: <App /> },                  // keep App here
  { path: "/viewer/:documentId", element: <Viewer /> },
  { path: "*", element: <Navigate to="/" replace /> }, // unknown -> Landing
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);