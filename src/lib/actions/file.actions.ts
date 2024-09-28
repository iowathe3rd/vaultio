"use server";

import { getCurrentUser } from "@/lib/actions/user.actions";
import { createAdminClient, createSessionClient } from "@/lib/appwrite";
import { appwriteConfig } from "@/lib/appwrite/config";
import { constructFileUrl, getFileType, parseStringify } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { ID, Models, Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

/**
 * Centralized error handler: logs and throws error with a message.
 * @param error Error object.
 * @param message Custom error message.
 */
const handleError = (error: unknown, message: string) => {
  console.error(message, error);
  throw new Error(message);
};

/**
 * Uploads a file to storage and creates its record in the database.
 * @param file File data.
 * @param ownerId Owner ID.
 * @param accountId Account ID.
 * @param path Path for page revalidation.
 */
export const uploadFile = async ({
  file,
  ownerId,
  accountId,
  path,
}: UploadFileProps) => {
  const { storage, databases } = await createAdminClient();

  try {
    if (!file || !file.name) throw new Error("Invalid file input");

    const inputFile = InputFile.fromBuffer(file, file.name);

    const bucketFile = await storage.createFile(
      appwriteConfig.bucketId,
      ID.unique(),
      inputFile
    );

    const fileType = getFileType(bucketFile.name);
    const fileDocument = {
      type: fileType.type,
      name: bucketFile.name,
      url: constructFileUrl(bucketFile.$id),
      extension: fileType.extension,
      size: bucketFile.sizeOriginal,
      owner: ownerId,
      accountId,
      users: [],
      bucketFileId: bucketFile.$id,
    };

    const newFile = await databases
      .createDocument(
        appwriteConfig.databaseId,
        appwriteConfig.filesCollectionId,
        ID.unique(),
        fileDocument
      )
      .catch(async (error) => {
        await storage.deleteFile(appwriteConfig.bucketId, bucketFile.$id);
        handleError(error, "Failed to create file document");
      });

    revalidatePath(path);
    return parseStringify(newFile);
  } catch (error) {
    handleError(error, "Failed to upload file");
  }
};

/**
 * Creates queries for filtering files.
 * @param currentUser Current user document.
 * @param types Array of file types.
 * @param searchText Search text string.
 * @param sort Sort parameter (e.g., "$createdAt-desc").
 * @param limit Optional limit for the query.
 * @returns Array of queries.
 */
const createQueries = (
  currentUser: Models.Document,
  types: string[],
  searchText: string,
  sort: string,
  limit?: number
) => {
  const queries = [
    Query.or([
      Query.equal("owner", [currentUser.$id]),
      Query.contains("users", [currentUser.email]),
    ]),
  ];

  if (types.length > 0) queries.push(Query.equal("type", types));
  if (searchText) queries.push(Query.contains("name", searchText));
  if (limit) queries.push(Query.limit(limit));

  if (sort) {
    const [sortBy, orderBy] = sort.split("-");
    queries.push(
      orderBy === "asc" ? Query.orderAsc(sortBy) : Query.orderDesc(sortBy)
    );
  }

  return queries;
};

/**
 * Fetches a list of files belonging to the current user.
 * @param types File types to filter by.
 * @param searchText Text to search in file names.
 * @param sort Sorting criteria.
 * @param limit Optional limit for the query.
 */
export const getFiles = async ({
  types = [],
  searchText = "",
  sort = "$createdAt-desc",
  limit,
}: GetFilesProps) => {
  try {
    const { databases } = await createAdminClient();
    const currentUser = await getCurrentUser();

    if (!currentUser) throw new Error("User not found");

    const queries = createQueries(currentUser, types, searchText, sort, limit);
    const files = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      queries
    );

    return parseStringify(files);
  } catch (error) {
    handleError(error, "Failed to get files");
  }
};

/**
 * Renames a file in the database.
 * @param fileId ID of the file.
 * @param name New file name.
 * @param extension File extension.
 * @param path Path for page revalidation.
 */
export const renameFile = async ({
  fileId,
  name,
  extension,
  path,
}: RenameFileProps) => {
  try {
    const { databases } = await createAdminClient();

    if (!fileId || !name || !extension) {
      throw new Error("Invalid input for renaming file");
    }

    const newName = `${name}.${extension}`;
    const updatedFile = await databases.updateDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
      { name: newName }
    );

    revalidatePath(path);
    return parseStringify(updatedFile);
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

/**
 * Updates the list of users with access to a file.
 * @param fileId ID of the file.
 * @param emails Array of user email addresses.
 * @param path Path for page revalidation.
 */
export const updateFileUsers = async ({
  fileId,
  emails,
  path,
}: UpdateFileUsersProps) => {
  try {
    const { databases } = await createAdminClient();

    if (!fileId || !emails || !Array.isArray(emails)) {
      throw new Error("Invalid input for updating file users");
    }

    const updatedFile = await databases.updateDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
      { users: emails }
    );

    revalidatePath(path);
    return parseStringify(updatedFile);
  } catch (error) {
    handleError(error, "Failed to update file users");
  }
};

/**
 * Deletes a file from storage and removes its record from the database.
 * @param fileId ID of the file record in the database.
 * @param bucketFileId ID of the file in storage.
 * @param path Path for page revalidation.
 */
export const deleteFile = async ({
  fileId,
  bucketFileId,
  path,
}: DeleteFileProps) => {
  const { databases, storage } = await createAdminClient();

  try {
    const deletedFile = await databases.deleteDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId
    );

    if (deletedFile) {
      await storage.deleteFile(appwriteConfig.bucketId, bucketFileId);
    }

    revalidatePath(path);
    return parseStringify({ status: "success" });
  } catch (error) {
    handleError(error, "Failed to delete file");
  }
};

/**
 * Calculates the total space used by the user's files.
 */
export async function getTotalSpaceUsed() {
  try {
    const { databases } = await createSessionClient();
    const currentUser = await getCurrentUser();

    if (!currentUser) throw new Error("User is not authenticated.");

    const files = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      [Query.equal("owner", [currentUser.$id])]
    );

    // Явный тип для totalSpace
    interface FileTypeSpace {
      size: number;
      latestDate: string;
    }

    interface TotalSpace {
      image: FileTypeSpace;
      document: FileTypeSpace;
      video: FileTypeSpace;
      audio: FileTypeSpace;
      other: FileTypeSpace;
      used: number;
      all: number;
    }

    const totalSpace: TotalSpace = {
      image: { size: 0, latestDate: "" },
      document: { size: 0, latestDate: "" },
      video: { size: 0, latestDate: "" },
      audio: { size: 0, latestDate: "" },
      other: { size: 0, latestDate: "" },
      used: 0,
      all: 2 * 1024 * 1024 * 1024, // 2GB available storage
    };

    files.documents.forEach((file) => {
      const fileType = file.type as keyof TotalSpace;

      if (fileType in totalSpace && fileType !== "used" && fileType !== "all") {
        totalSpace[fileType].size += file.size;
        totalSpace.used += file.size;

        if (
          !totalSpace[fileType].latestDate ||
          new Date(file.$updatedAt) > new Date(totalSpace[fileType].latestDate)
        ) {
          totalSpace[fileType].latestDate = file.$updatedAt;
        }
      }
    });

    return parseStringify(totalSpace);
  } catch (error) {
    handleError(error, "Error calculating total space used");
  }
}