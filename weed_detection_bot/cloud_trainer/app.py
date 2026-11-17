import os
import subprocess
import streamlit as st
from PIL import Image
from streamlit_drawable_canvas import st_canvas

# ==========================================
# 1. SET THE KAGGLE PASSWORD SECURELY
# ==========================================
# Revoke your old token on Kaggle and paste the new one here. Do NOT push this to GitHub.
os.environ["KAGGLE_API_TOKEN"] =  your api key

# ==========================================
# 2. SECURITY GATE: LOGIN SCREEN
# ==========================================
SECRET_PASSWORD = your password

if "logged_in" not in st.session_state:
    st.session_state["logged_in"] = False

if not st.session_state["logged_in"]:
    st.title("🔒 System Login")
    st.warning("Please enter the admin password to access the Cloud Trainer.")
    
    password_input = st.text_input("Password", type="password")
    if st.button("Login"):
        if password_input == SECRET_PASSWORD:
            st.session_state["logged_in"] = True
            st.rerun() # Refresh the page to load the main app
        else:
            st.error("Incorrect Password.")
    st.stop() # This completely hides the rest of the app until logged in

# ==========================================
# MAIN APP CONFIGURATION
# ==========================================
# Define paths based on your dataset structure
IMAGE_DIR = "dataset/images/train"
LABEL_DIR = "dataset/labels/train"
os.makedirs(IMAGE_DIR, exist_ok=True)
os.makedirs(LABEL_DIR, exist_ok=True)

st.title("🌱 Weed & Crop Cloud Trainer")

# Create the Tabbed Interface
tab_annotate, tab_dashboard = st.tabs(["🖌️ Data Annotation & Sync", "📊 Training Dashboard"])

# ==========================================
# TAB 1: UPLOAD AND ANNOTATE
# ==========================================
with tab_annotate:
    st.header("1. Upload & Annotate")
    classes = {"Crop": 0, "Weed": 1}

    # This creates the browse/drag-and-drop box
    image_file = st.file_uploader("Upload an Image", type=['jpg', 'png', 'jpeg'])

    if image_file:
        image = Image.open(image_file)
        img_width, img_height = image.size
        canvas_width = 600
        canvas_height = int((canvas_width / img_width) * img_height)

        st.write("**Draw boxes around Weeds or Crops.**")

        # The interactive drawing canvas
        canvas_result = st_canvas(
            fill_color="rgba(255, 165, 0, 0.3)",
            stroke_width=3,
            stroke_color="#00FF00",
            background_image=image,
            update_streamlit=True,
            height=canvas_height,
            width=canvas_width,
            drawing_mode="rect",
            key="canvas",
        )

        current_class = st.radio("Select Class:", ["Crop", "Weed"])
        
        st.write("---")
        
        # UI Buttons side-by-side
        col1, col2 = st.columns(2)
        
        with col1:
            save_annotated = st.button("💾 Save Annotated Image", type="primary")
        with col2:
            save_negative = st.button("🚫 Save as Negative (No Targets)")

        # Logic for saving an image WITH bounding boxes
        if save_annotated:
            image_path = os.path.join(IMAGE_DIR, image_file.name)
            with open(image_path, "wb") as f:
                f.write(image_file.getbuffer())

            # Save Labels if a box was drawn
            if canvas_result.json_data is not None and len(canvas_result.json_data["objects"]) > 0:
                yolo_labels = []
                for obj in canvas_result.json_data["objects"]:
                    x = obj["left"] / canvas_width
                    y = obj["top"] / canvas_height
                    w = obj["width"] / canvas_width
                    h = obj["height"] / canvas_height
                    x_center = x + (w / 2)
                    y_center = y + (h / 2)
                    class_id = classes[current_class] 
                    yolo_labels.append(f"{class_id} {x_center:.6f} {y_center:.6f} {w:.6f} {h:.6f}")
                
                txt_filename = os.path.splitext(image_file.name)[0] + ".txt"
                label_path = os.path.join(LABEL_DIR, txt_filename)
                with open(label_path, "w") as f:
                    f.write("\n".join(yolo_labels))
                st.success(f"✅ Saved Labeled Image: {image_file.name}")
            else:
                st.warning("⚠️ No boxes were drawn! If you meant to save a background image without targets, click 'Save as Negative' instead.")

        # Logic for saving an image WITHOUT boxes (Negative Training)
        if save_negative:
            image_path = os.path.join(IMAGE_DIR, image_file.name)
            with open(image_path, "wb") as f:
                f.write(image_file.getbuffer())
            # We purposely do NOT write a .txt file here. YOLO reads missing txt files as pure background.
            st.success(f"✅ Saved as Negative Background Image (No labels): {image_file.name}")

    st.divider()
    st.header("Sync & Train on Cloud")

    if st.button("Push to Kaggle & Start Training 🚀", type="primary"):
        with st.spinner("Pushing new images to Kaggle..."):
            subprocess.run(
                'kaggle datasets version -p ./dataset -m "Added new field images" --dir-mode zip', 
                shell=True, capture_output=True, text=True, encoding="utf-8"
            )
            subprocess.run(
                'kaggle kernels push -p ./my_notebook', 
                shell=True, capture_output=True, text=True, encoding="utf-8"
            )
            
        st.success("Data synced and cloud training started! You can track progress in the Dashboard tab.")

# ==========================================
# TAB 2: TRAINING DASHBOARD
# ==========================================
with tab_dashboard:
    st.header("Model Performance Metrics")
    st.write("Pulling latest training data from Kaggle...")
    
    if st.button("Fetch Latest Results from Kaggle"):
        with st.spinner("Downloading training graphs..."):
            # 1. Define where to save the downloaded output
            RESULTS_DIR = "./kaggle_output"
            os.makedirs(RESULTS_DIR, exist_ok=True)
            
            # 2. Pull the notebook output from Kaggle (--force prevents skipping)
            pull_command = f"kaggle kernels output dummyguestaccount/notebook1 -p {RESULTS_DIR} --force"
            
            # Capture the result of the command silently
            result = subprocess.run(pull_command, shell=True, capture_output=True, text=True, encoding="utf-8")
            
            # --- NEW DEBUGGER UI ---
            with st.expander("🛠️ View Terminal Logs (Click to expand)"):
                st.write("**Standard Output:**")
                st.code(result.stdout)
                if result.stderr:
                    st.write("**Errors:**")
                    st.code(result.stderr)
            # -----------------------
            
            # 3. Look for the results.png file downloaded from YOLO
            results_img_path = os.path.join(RESULTS_DIR, "runs/detect/train/results.png")
            confusion_matrix_path = os.path.join(RESULTS_DIR, "runs/detect/train/confusion_matrix.png")
            
            # 4. Display the images in Streamlit (Using PIL to prevent cache errors)
            if os.path.exists(results_img_path):
                st.success("Latest training metrics retrieved!")
                
                # Use Streamlit columns to show images side-by-side
                col1, col2 = st.columns(2)
                with col1:
                    st.image(Image.open(results_img_path), caption="Training Loss & Accuracy")
                with col2:
                    if os.path.exists(confusion_matrix_path):
                        st.image(Image.open(confusion_matrix_path), caption="Confusion Matrix")
            else:
                st.error("Could not find results.png. Check the Terminal Logs above to see what happened.")